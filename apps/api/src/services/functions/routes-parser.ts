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
    const stem = stemOf(file.path)
    if (stem === "") continue
    DEF_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = DEF_RE.exec(file.content)) !== null) {
      const symbol = m[1]!
      if (symbol.startsWith("_")) continue
      routes.push({
        path: routePath(stem, symbol),
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

// Filename without extension and without the userFolder prefix —
// matches the `path.stem` Starlette uses, except for nested files
// where we keep the directory components so foo/bar.py:def main
// becomes /foo/bar (matches no Python convention, but works for now —
// runner will need the same logic if we later support nesting).
function stemOf(path: string): string {
  const noExt = path.replace(/\.py$/, "")
  const slash = noExt.lastIndexOf("/")
  return slash === -1 ? noExt : noExt.slice(slash + 1)
}

function routePath(fileStem: string, funcName: string): string {
  const base = fileStem === "main" ? "" : `/${fileStem}`
  const suffix = funcName === "main" ? "" : `/${funcName}`
  return base + suffix || "/"
}
