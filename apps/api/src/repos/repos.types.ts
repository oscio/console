// Standalone Forgejo repos managed from the /repos page. Phase-2:
// just a thin registry over Forgejo — we keep slug/name/owner in our
// DB for FGA + ownership queries, the actual git data lives in
// Forgejo at <functionOrg>/<slug>. Function-backed repos live in the
// function table separately so their runtime metadata stays cleanly
// scoped.

export type RepoSource = "forgejo" | "github-import"

export type Repo = {
  id: string
  slug: string
  name: string
  owner: string
  // "forgejo" = empty repo created on this platform.
  // "github-import" = one-time copy of a GitHub repo via Forgejo migrate.
  source: RepoSource
  // Web URL into Forgejo. "" when client isn't configured.
  forgejoUrl: string
  // https URL the user can git clone (always populated when Forgejo
  // is configured; auth handled by the workspace pod's auto-mounted
  // credentials).
  cloneUrl: string
  createdAt: string
}

export type CreateRepoInput = {
  name: string
}

export type ImportRepoInput = {
  // Public or private GitHub URL. Private requires githubToken.
  githubUrl: string
  // Optional name override; defaults to the GitHub repo's last path
  // segment. Always sanitised to a slug before being used as the
  // Forgejo repo name.
  name?: string
  // PAT with repo:read scope, used for the migrate API call only.
  // Never persisted.
  githubToken?: string
}
