import { Injectable, Logger } from "@nestjs/common"

// Thin Forgejo REST client. Phase-2 only needs repo CRUD under a
// single platform admin account — per-user auth is intentionally
// skipped, so every call uses the same Basic credentials.
//
// Env contract (set by the console tf module):
//   FORGEJO_INTERNAL_URL    in-cluster base, e.g.
//                           http://forgejo-http.platform-forgejo.svc.cluster.local:3000
//   FORGEJO_PUBLIC_URL      user-facing base, e.g. https://git.<domain>
//   FORGEJO_ADMIN_USER      basic-auth username
//   FORGEJO_ADMIN_PASSWORD  basic-auth password
//   FORGEJO_FUNCTION_ORG    org user-generated function repos live in (default `service`)
//   FORGEJO_TEMPLATE_ORG    org the template repos are forked into by tf (default `platform`)
//
// When FORGEJO_INTERNAL_URL is empty the client is `disabled` and
// FunctionsService falls back to DB-only behaviour. That's the
// bridge state while tf hasn't wired creds yet — once configured,
// create()/delete() cascade to a repo.

@Injectable()
export class ForgejoClient {
  private readonly log = new Logger(ForgejoClient.name)
  private readonly internalUrl = (
    process.env.FORGEJO_INTERNAL_URL ?? ""
  ).replace(/\/$/, "")
  private readonly publicUrl = (
    process.env.FORGEJO_PUBLIC_URL ?? ""
  ).replace(/\/$/, "")
  private readonly user = process.env.FORGEJO_ADMIN_USER ?? ""
  private readonly password = process.env.FORGEJO_ADMIN_PASSWORD ?? ""
  readonly functionOrg = process.env.FORGEJO_FUNCTION_ORG || "service"
  // Org tf forks the platform-managed template repos into. Templates
  // are NOT under functionOrg because user functions and platform
  // templates have separate lifecycles (templates managed via tf
  // forks; functions managed by users via console).
  readonly templateOrg = process.env.FORGEJO_TEMPLATE_ORG || "platform"

  get enabled(): boolean {
    return !!this.internalUrl && !!this.user && !!this.password
  }

  // User-facing URL for "Open in Forgejo" links. Falls back to the
  // internal URL when no public URL is configured (handy in tests).
  repoWebUrl(repoName: string): string {
    const base = this.publicUrl || this.internalUrl
    if (!base) return ""
    return `${base}/${this.functionOrg}/${repoName}`
  }

  // Public clone URL — same shape as repoWebUrl but `.git` suffixed
  // for `git clone`. Empty string when Forgejo isn't configured.
  repoCloneUrl(repoName: string): string {
    const web = this.repoWebUrl(repoName)
    return web ? `${web}.git` : ""
  }

  // Idempotent enough: creates the org if missing. Forgejo returns 422
  // "user already exists" on a duplicate, which we treat as success.
  async ensureOrg(name: string): Promise<void> {
    const r = await this.request("POST", "/api/v1/orgs", { username: name })
    if (r.status === 201) return
    if (r.status === 422) return
    if (r.status === 409) return
    throw new Error(`Forgejo ensureOrg(${name}) -> ${r.status}: ${r.text}`)
  }

  // Auto-init creates an initial README + main branch. Subsequent
  // template files land via writeFile() (which overwrites the auto-init
  // README). Returns the clone URL (https) for downstream wiring.
  async createOrgRepo(input: {
    org: string
    name: string
    description?: string
    autoInit?: boolean
    private?: boolean
  }): Promise<{ cloneUrl: string }> {
    const r = await this.request(
      "POST",
      `/api/v1/orgs/${encodeURIComponent(input.org)}/repos`,
      {
        name: input.name,
        description: input.description ?? "",
        // Default false in dev so the unauthenticated cluster runner
        // can clone. Prod migration will flip this on (per-user auth +
        // deploy tokens for the runner).
        private: input.private ?? false,
        auto_init: input.autoInit ?? true,
        default_branch: "main",
      },
    )
    if (r.status !== 201) {
      throw new Error(
        `Forgejo createOrgRepo(${input.org}/${input.name}) -> ${r.status}: ${r.text}`,
      )
    }
    const body = JSON.parse(r.text) as { clone_url?: string }
    return { cloneUrl: body.clone_url ?? "" }
  }

  // ---- file contents ------------------------------------------------------
  // Forgejo's contents API takes one file per call and creates a commit
  // for each. We accept the round-trip cost — repos are tiny (a handful
  // of files) and this avoids dragging in a lower-level git library.

  async getFileContent(input: {
    org: string
    repo: string
    path: string
    ref?: string
  }): Promise<{ content: string; sha: string } | null> {
    const ref = input.ref ? `?ref=${encodeURIComponent(input.ref)}` : ""
    const r = await this.request(
      "GET",
      `/api/v1/repos/${encodeURIComponent(input.org)}/${encodeURIComponent(input.repo)}/contents/${encodeURIComponent(input.path)}${ref}`,
    )
    if (r.status === 404) return null
    if (r.status !== 200) {
      throw new Error(
        `Forgejo getFileContent(${input.org}/${input.repo}:${input.path}) -> ${r.status}: ${r.text}`,
      )
    }
    const body = JSON.parse(r.text) as {
      content?: string
      encoding?: string
      sha?: string
    }
    const sha = body.sha ?? ""
    if (body.encoding !== "base64" || typeof body.content !== "string") {
      throw new Error(
        `Forgejo getFileContent: unexpected encoding ${body.encoding ?? "?"}`,
      )
    }
    const content = Buffer.from(body.content, "base64").toString("utf-8")
    return { content, sha }
  }

  // Write a file. Auto-detects create vs update — if Forgejo returns
  // 422 ("file already exists") on POST, the method GETs the current
  // sha and retries via PUT. Returns the new blob SHA.
  async writeFile(input: {
    org: string
    repo: string
    path: string
    content: string
    message: string
    branch?: string
  }): Promise<{ sha: string }> {
    const url = `/api/v1/repos/${encodeURIComponent(input.org)}/${encodeURIComponent(input.repo)}/contents/${encodeURIComponent(input.path)}`
    const body: Record<string, unknown> = {
      content: Buffer.from(input.content, "utf-8").toString("base64"),
      message: input.message,
    }
    if (input.branch) body.branch = input.branch

    let r = await this.request("POST", url, body)
    if (r.status === 201) {
      const parsed = JSON.parse(r.text) as { content?: { sha?: string } }
      return { sha: parsed.content?.sha ?? "" }
    }
    // File already exists — fetch its sha and retry as PUT.
    if (r.status === 422 || r.status === 409) {
      const existing = await this.getFileContent({
        org: input.org,
        repo: input.repo,
        path: input.path,
        ref: input.branch,
      })
      if (!existing) {
        throw new Error(
          `Forgejo writeFile fallback: ${input.path} reported conflict but GET returned 404`,
        )
      }
      r = await this.request("PUT", url, { ...body, sha: existing.sha })
      if (r.status === 200) {
        const parsed = JSON.parse(r.text) as { content?: { sha?: string } }
        return { sha: parsed.content?.sha ?? "" }
      }
    }
    throw new Error(
      `Forgejo writeFile(${input.org}/${input.repo}:${input.path}) -> ${r.status}: ${r.text}`,
    )
  }

  // List a directory under a repo. Single-level — caller does the
  // recursion if it wants a tree. Each entry has `type=file|dir`,
  // `name`, `path`, `sha`, `size`. Returns [] when the path is empty
  // or doesn't exist (404 collapses to empty rather than throwing,
  // matching the listing-fits-empty UX).
  async listDirectory(input: {
    org: string
    repo: string
    path: string
    ref?: string
  }): Promise<
    Array<{ type: "file" | "dir"; name: string; path: string; sha: string; size: number }>
  > {
    const ref = input.ref ? `?ref=${encodeURIComponent(input.ref)}` : ""
    const r = await this.request(
      "GET",
      `/api/v1/repos/${encodeURIComponent(input.org)}/${encodeURIComponent(input.repo)}/contents/${encodeURIComponent(input.path)}${ref}`,
    )
    if (r.status === 404) return []
    if (r.status !== 200) {
      throw new Error(
        `Forgejo listDirectory(${input.org}/${input.repo}:${input.path}) -> ${r.status}: ${r.text}`,
      )
    }
    const body = JSON.parse(r.text)
    if (!Array.isArray(body)) return []
    return body
      .filter(
        (e: { type?: string; name?: string }) =>
          (e.type === "file" || e.type === "dir") && typeof e.name === "string",
      )
      .map((e: { type: string; name: string; path: string; sha: string; size: number }) => ({
        type: e.type as "file" | "dir",
        name: e.name,
        path: e.path,
        sha: e.sha,
        size: e.size,
      }))
  }

  // Single repo metadata. 404 → null. Used by /repos to hydrate a
  // slug returned by FGA into the user-facing fields (description,
  // created_at, original_url, etc.) without a DB cache layer.
  async getRepo(input: {
    org: string
    repo: string
  }): Promise<RepoMetadata | null> {
    const r = await this.request(
      "GET",
      `/api/v1/repos/${encodeURIComponent(input.org)}/${encodeURIComponent(input.repo)}`,
    )
    if (r.status === 404) return null
    if (r.status !== 200) {
      throw new Error(
        `Forgejo getRepo(${input.org}/${input.repo}) -> ${r.status}: ${r.text}`,
      )
    }
    return parseRepoMetadata(JSON.parse(r.text))
  }

  // Bulk-list every repo under an org. Pagination ceiling: Phase-2
  // is single-digit users with maybe a dozen repos each; we read up
  // to `limit` per page and stop after the first underfull page.
  async listOrgRepos(input: {
    org: string
    limit?: number
  }): Promise<RepoMetadata[]> {
    const limit = input.limit ?? 50
    const out: RepoMetadata[] = []
    let page = 1
    while (true) {
      const r = await this.request(
        "GET",
        `/api/v1/orgs/${encodeURIComponent(input.org)}/repos?limit=${limit}&page=${page}`,
      )
      if (r.status === 404) return out
      if (r.status !== 200) {
        throw new Error(
          `Forgejo listOrgRepos(${input.org}) -> ${r.status}: ${r.text}`,
        )
      }
      const body = JSON.parse(r.text)
      if (!Array.isArray(body)) return out
      for (const item of body) out.push(parseRepoMetadata(item))
      if (body.length < limit) return out
      page++
      if (page > 20) return out // hard cap, never expected to hit
    }
  }

  // Forgejo's "generate from template" — server-side fork that copies
  // the template repo into a new repo under `target_owner` in a single
  // commit. Caller must have set `template: true` on the source.
  async generateFromTemplate(input: {
    templateOwner: string
    templateRepo: string
    targetOwner: string
    targetName: string
    description?: string
    private?: boolean
  }): Promise<void> {
    const r = await this.request(
      "POST",
      `/api/v1/repos/${encodeURIComponent(input.templateOwner)}/${encodeURIComponent(input.templateRepo)}/generate`,
      {
        owner: input.targetOwner,
        name: input.targetName,
        description: input.description ?? "",
        private: input.private ?? false,
        default_branch: "main",
        git_content: true,
        git_hooks: false,
        labels: false,
        topics: false,
        webhooks: false,
      },
    )
    if (r.status !== 201) {
      throw new Error(
        `Forgejo generateFromTemplate(${input.templateOwner}/${input.templateRepo} → ${input.targetOwner}/${input.targetName}) -> ${r.status}: ${r.text}`,
      )
    }
  }

  // Set an org-level Forgejo Actions secret. Used to give the
  // `service` org access to the same HARBOR_USER/HARBOR_TOKEN the
  // `platform` org gets at fork time — without this, function repos
  // inside `service` can't `docker login` to Harbor and the build
  // workflow fails with "must provide --username with --password-stdin".
  async setOrgSecret(
    org: string,
    name: string,
    value: string,
  ): Promise<void> {
    const r = await this.request(
      "PUT",
      `/api/v1/orgs/${encodeURIComponent(org)}/actions/secrets/${encodeURIComponent(name)}`,
      { data: value },
    )
    // 201 = created, 204 = updated, 200 also seen depending on
    // version. Anything else is a problem.
    if (r.status !== 201 && r.status !== 204 && r.status !== 200) {
      throw new Error(
        `Forgejo setOrgSecret(${org}/${name}) -> ${r.status}: ${r.text}`,
      )
    }
  }

  // Latest commit SHA on a branch. Used by the Deploy flow to pin
  // the Knative Service image to a specific git revision.
  async getBranchHead(input: {
    org: string
    repo: string
    branch: string
  }): Promise<string | null> {
    const r = await this.request(
      "GET",
      `/api/v1/repos/${encodeURIComponent(input.org)}/${encodeURIComponent(input.repo)}/branches/${encodeURIComponent(input.branch)}`,
    )
    if (r.status === 404) return null
    if (r.status !== 200) {
      throw new Error(
        `Forgejo getBranchHead(${input.org}/${input.repo}:${input.branch}) -> ${r.status}: ${r.text}`,
      )
    }
    const body = JSON.parse(r.text) as { commit?: { id?: string } }
    return body.commit?.id ?? null
  }

  // Latest workflow run for a repo. Used by the Deploy flow to wait
  // for the build that pushes the per-commit image to Harbor before
  // we patch the Knative Service. Returns null when no runs exist.
  async getLatestWorkflowRun(input: {
    org: string
    repo: string
  }): Promise<{
    headSha: string
    status: string
    displayTitle: string
  } | null> {
    const r = await this.request(
      "GET",
      `/api/v1/repos/${encodeURIComponent(input.org)}/${encodeURIComponent(input.repo)}/actions/tasks?limit=1`,
    )
    if (r.status === 404) return null
    if (r.status !== 200) {
      throw new Error(
        `Forgejo getLatestWorkflowRun(${input.org}/${input.repo}) -> ${r.status}: ${r.text}`,
      )
    }
    const body = JSON.parse(r.text) as {
      workflow_runs?: Array<{
        head_sha?: string
        status?: string
        display_title?: string
      }>
    }
    const run = body.workflow_runs?.[0]
    if (!run?.head_sha) return null
    return {
      headSha: run.head_sha,
      status: run.status ?? "",
      displayTitle: run.display_title ?? "",
    }
  }

  // Manually trigger a workflow that supports `on: workflow_dispatch`.
  // Used after `generateFromTemplate` because Forgejo doesn't fire the
  // push event for the template-generated initial commit, so the very
  // first build never runs unless we kick it off ourselves. 204 is
  // "queued"; 404 means the workflow isn't on the ref or doesn't list
  // workflow_dispatch as a trigger.
  async dispatchWorkflow(input: {
    org: string
    repo: string
    workflow: string
    ref: string
  }): Promise<void> {
    const r = await this.request(
      "POST",
      `/api/v1/repos/${encodeURIComponent(input.org)}/${encodeURIComponent(input.repo)}/actions/workflows/${encodeURIComponent(input.workflow)}/dispatches`,
      { ref: input.ref },
    )
    if (r.status !== 204 && r.status !== 200) {
      throw new Error(
        `Forgejo dispatchWorkflow(${input.org}/${input.repo}:${input.workflow}@${input.ref}) -> ${r.status}: ${r.text}`,
      )
    }
  }

  // Promote a repo to template status. Idempotent: 200 either way.
  async markRepoAsTemplate(org: string, repo: string): Promise<void> {
    const r = await this.request(
      "PATCH",
      `/api/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`,
      { template: true },
    )
    if (r.status !== 200) {
      throw new Error(
        `Forgejo markRepoAsTemplate(${org}/${repo}) -> ${r.status}: ${r.text}`,
      )
    }
  }

  // Toggle the repo's visibility flag. Used so prod deployments can
  // make function repos truly private (today they're always public to
  // keep the runner unauthenticated; per-user auth lands later).
  async setRepoVisibility(
    org: string,
    repo: string,
    isPrivate: boolean,
  ): Promise<void> {
    const r = await this.request(
      "PATCH",
      `/api/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`,
      { private: isPrivate },
    )
    if (r.status !== 200) {
      throw new Error(
        `Forgejo setRepoVisibility(${org}/${repo}) -> ${r.status}: ${r.text}`,
      )
    }
  }

  // Delete a single file in a repo. Forgejo demands the current
  // blob SHA — we fetch it transparently so the caller doesn't have
  // to. 404 collapses to a no-op (caller's intent: "make it gone").
  async deleteFile(input: {
    org: string
    repo: string
    path: string
    message: string
    branch?: string
  }): Promise<void> {
    const existing = await this.getFileContent({
      org: input.org,
      repo: input.repo,
      path: input.path,
      ref: input.branch,
    })
    if (!existing) return
    const url = `/api/v1/repos/${encodeURIComponent(input.org)}/${encodeURIComponent(input.repo)}/contents/${encodeURIComponent(input.path)}`
    const r = await this.request("DELETE", url, {
      message: input.message,
      sha: existing.sha,
      ...(input.branch ? { branch: input.branch } : {}),
    })
    if (r.status !== 200 && r.status !== 204 && r.status !== 404) {
      throw new Error(
        `Forgejo deleteFile(${input.org}/${input.repo}:${input.path}) -> ${r.status}: ${r.text}`,
      )
    }
  }

  // 404 is fine — already gone is the desired state.
  async deleteRepo(org: string, name: string): Promise<void> {
    const r = await this.request(
      "DELETE",
      `/api/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(name)}`,
    )
    if (r.status !== 204 && r.status !== 404) {
      throw new Error(
        `Forgejo deleteRepo(${org}/${name}) -> ${r.status}: ${r.text}`,
      )
    }
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; text: string }> {
    if (!this.enabled) {
      throw new Error(
        "Forgejo client is not configured (set FORGEJO_INTERNAL_URL/_USER/_PASSWORD).",
      )
    }
    const auth = Buffer.from(`${this.user}:${this.password}`).toString("base64")
    const res = await fetch(`${this.internalUrl}${path}`, {
      method,
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text().catch(() => "")
    return { status: res.status, text }
  }
}

// The slice of Forgejo's repo response we surface to callers. Picked
// to cover the /repos page without needing extra round-trips.
export type RepoMetadata = {
  // Forgejo's repo name (the URL slug under the org). Stable id.
  name: string
  // Repo description (free-text). Empty string if unset.
  description: string
  // True when imported from a remote — `original_url` is the source.
  // Used to label the repo as "github-import" vs "forgejo".
  originalUrl: string
  cloneUrl: string
  htmlUrl: string
  // ISO-8601 timestamps from Forgejo.
  createdAt: string
  updatedAt: string
}

function parseRepoMetadata(raw: unknown): RepoMetadata {
  const r = raw as {
    name?: string
    description?: string
    original_url?: string
    clone_url?: string
    html_url?: string
    created_at?: string
    updated_at?: string
  }
  return {
    name: r.name ?? "",
    description: r.description ?? "",
    originalUrl: r.original_url ?? "",
    cloneUrl: r.clone_url ?? "",
    htmlUrl: r.html_url ?? "",
    createdAt: r.created_at ?? "",
    updatedAt: r.updated_at ?? "",
  }
}
