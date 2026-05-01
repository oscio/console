// Static parser for function/*.py — derives the same routes the
// Starlette runner builds at import time. Used by:
//   GET /functions/:slug/routes   → Test tab populates from this
//
// The parser is regex-based. Vercel-style routing means we only
// emit one route per file (the file's `main` callable); we don't
// care about other top-level defs.

export type DiscoveredRoute = {
  // Full URL path:
  //   function/main.py            → "/"
  //   function/foo.py             → "/foo"
  //   function/users/main.py      → "/users"          (dir index)
  //   function/users/list.py      → "/users/list"
  path: string
  // The user-folder file the symbol lives in, and the always-`main`
  // entrypoint name. Symbol stays in the type so the UI can keep
  // labeling routes by `<file>:<symbol>` for clarity.
  file: string
  symbol: "main"
}

// Top-level `def main(` or `async def main(`. MULTILINE so the `^`
// matches start-of-line; we don't want to mount nested defs.
const MAIN_DEF_RE = /^(?:async\s+)?def\s+main\s*\(/m

export function parseRoutes(
  userFolder: string,
  files: { path: string; content: string }[],
): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = []
  for (const file of files) {
    if (!file.path.startsWith(userFolder + "/")) continue
    if (!file.path.endsWith(".py")) continue
    if (file.path.endsWith("/__init__.py")) continue
    if (!MAIN_DEF_RE.test(file.content)) continue
    const rel = file.path.slice(userFolder.length + 1).replace(/\.py$/, "")
    if (!rel) continue
    routes.push({
      path: routePath(rel),
      file: file.path,
      symbol: "main",
    })
  }
  // Stable order: shorter paths first, alpha within same length.
  routes.sort((a, b) => {
    if (a.path.length !== b.path.length) return a.path.length - b.path.length
    return a.path.localeCompare(b.path)
  })
  return routes
}

// Mirrors the Starlette runner's `_route_path` exactly. Strip the
// trailing `main` segment (the dir's index) so e.g. function/users/
// main.py becomes /users.
function routePath(relPath: string): string {
  if (relPath === "main") return "/"
  if (relPath.endsWith("/main")) return "/" + relPath.slice(0, -"/main".length)
  return "/" + relPath
}
