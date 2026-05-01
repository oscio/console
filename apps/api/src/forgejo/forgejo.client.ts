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

  // Auto-init creates the README so the repo has a default branch.
  // Subsequent commits land via /repos/.../contents API. Returns the
  // clone URL (https) for downstream wiring.
  async createOrgRepo(input: {
    org: string
    name: string
    description?: string
    autoInit?: boolean
  }): Promise<{ cloneUrl: string }> {
    const r = await this.request(
      "POST",
      `/api/v1/orgs/${encodeURIComponent(input.org)}/repos`,
      {
        name: input.name,
        description: input.description ?? "",
        // Public so the in-cluster runner + buildpacks Job can clone
        // without a token. Visibility on the console side is
        // FGA-driven, independent of this flag.
        private: false,
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
