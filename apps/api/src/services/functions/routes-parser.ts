// Static parser for the function/*.py user code — derives the same
// route shapes the Starlette runner builds at import time. Used by:
//   - GET /functions/:slug/routes   → Test tab populates from this
//
// The parser is regex-based. It misses pathological cases (e.g. a
// `def` inside a triple-quoted string) but those are rare, the cost
// of getting them wrong is low (one ghost route in the Test UI), and
// we'd rather not pull a Python AST package into a Node service.

export type DiscoveredRoute = {
  // Full URL path, mirroring runner _route_path():
  //   function/main.py:def main         → "/"
  //   function/main.py:def status       → "/status"
  //   function/foo.py:def main          → "/foo"
  //   function/foo.py:def list_items    → "/foo/list_items"
  path: string
  // File the function lives in (`function/main.py` etc.) and the
  // symbol name. Used by the UI to label routes and to deep-link
  // back into the editor.
  file: string
  symbol: string
}

// Matches top-level `def name(` or `async def name(`. Skips `_`-prefixed
// names (private convention). The leading `^` anchors to start-of-line
// in MULTILINE mode so we don't match nested defs.
const DEF_RE = /^(?:async\s+)?def\s+([A-Za-z][A-Za-z0-9_]*)\s*\(/gm

export function parseRoutes(
  userFolder: string,
  files: { path: string; content: string }[],
): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = []
  for (const file of files) {
    if (!file.path.startsWith(userFolder + "/")) continue
    if (!file.path.endsWith(".py")) continue
    if (file.path.endsWith("/__init__.py")) continue
    // Path relative to userFolder with the .py stripped — keeps
    // subdir info so foo/main.py and foo.py don't collapse together.
    const rel = file.path.slice(userFolder.length + 1).replace(/\.py$/, "")
    if (!rel) continue
    DEF_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = DEF_RE.exec(file.content)) !== null) {
      const symbol = m[1]!
      if (symbol.startsWith("_")) continue
      routes.push({
        path: routePath(rel, symbol),
        file: file.path,
        symbol,
      })
    }
  }
  // Stable order: shorter paths first, alpha within same length.
  routes.sort((a, b) => {
    if (a.path.length !== b.path.length) return a.path.length - b.path.length
    return a.path.localeCompare(b.path)
  })
  return routes
}

// Mirrors the Starlette runner's `_route_path` exactly. Full
// relative path + symbol name; ONE special case — function/main.py
// :def main → "/". Anything else is a verbose-but-unambiguous URL.
function routePath(relPath: string, funcName: string): string {
  if (relPath === "main" && funcName === "main") return "/"
  return `/${relPath}/${funcName}`
}
