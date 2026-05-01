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
//   FORGEJO_FUNCTION_ORG    org under which function repos live (default `service`)
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
