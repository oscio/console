// Standalone Forgejo repos managed from the /repos page. Phase-2:
// just a thin registry over Forgejo — we keep slug/name/owner in our
// DB for FGA + ownership queries, the actual git data lives in
// Forgejo at <functionOrg>/<slug>. Function-backed repos live in the
// function table separately so their runtime metadata stays cleanly
// scoped.

export type RepoSource = "forgejo" | "github-import"

// Where a repo lives in the Forgejo org tree:
//   "mine"     — user-created standalone repo under functionOrg, FGA
//                tuple grants ownership; deletable from console.
//   "platform" — tf-forked repo under templateOrg (function template,
//                infra, agents, etc.). Read-only from console. Listed
//                so users can see clone URLs for in-VM checkouts.
export type RepoKind = "mine" | "platform"

export type Repo = {
  id: string
  slug: string
  name: string
  // Forgejo org the repo lives in (functionOrg for "mine",
  // templateOrg for "platform").
  forgejoOrg: string
  kind: RepoKind
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

export type ForkRepoInput = {
  // Source repo on Forgejo (any org the platform makes available
  // through /repos/sources). The fork lands as a fresh, editable copy
  // under the function org owned by the caller.
  sourceOrg: string
  sourceName: string
  // Optional rename for the fork; defaults to sourceName. Sanitised
  // to a slug before use.
  name?: string
}

export type ImportRepoInput = {
  // Public GitHub URL — Phase-2 doesn't accept PATs, so private repos
  // can't be imported through this flow.
  githubUrl: string
  // Optional name override; defaults to the GitHub repo's last path
  // segment. Sanitised to a slug.
  name?: string
}
