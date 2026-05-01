"use client"

import { useMemo, useState, useTransition } from "react"
import dynamic from "next/dynamic"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { Button } from "@workspace/ui/components/button"
import {
  CaretDown,
  CaretRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  Plus,
  X,
} from "@phosphor-icons/react"

// Monaco's React wrapper pulls a heavy bundle and references `window`
// so it's client-only via dynamic import. SSR is unnecessary — the
// editor only matters once the user lands on the detail page.
const Monaco = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
      Loading editor…
    </div>
  ),
})

type FileEntry = { path: string; content: string }
type SaveInput = {
  files: FileEntry[]
  deletes: string[]
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  py: "python",
  js: "javascript",
  ts: "typescript",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  txt: "plaintext",
}

function languageForPath(path: string, fallback: string): string {
  const dot = path.lastIndexOf(".")
  if (dot === -1) return fallback
  const ext = path.slice(dot + 1).toLowerCase()
  return LANGUAGE_BY_EXT[ext] ?? fallback
}

// ---- tree shape -----------------------------------------------------------

type TreeNode =
  | { kind: "file"; path: string }
  | { kind: "dir"; path: string; children: TreeNode[] }

// Build a folder tree rooted at `rootFolder`. Only paths under that
// folder are nested in; everything else is dropped. Implicit folders
// (those that only exist because a file path contains them) get
// generated as `dir` nodes.
type DirNode = Extract<TreeNode, { kind: "dir" }>

function buildTree(rootFolder: string, paths: string[]): DirNode {
  const root: DirNode = { kind: "dir", path: rootFolder, children: [] }
  for (const p of paths) {
    if (!p.startsWith(rootFolder + "/")) continue
    const parts = p.slice(rootFolder.length + 1).split("/")
    let cur: DirNode = root
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1
      const piece = parts[i]!
      const childPath = `${cur.path}/${piece}`
      let child = cur.children.find((c) => c.path === childPath)
      if (!child) {
        child = isLeaf
          ? { kind: "file", path: childPath }
          : { kind: "dir", path: childPath, children: [] }
        cur.children.push(child)
      }
      if (isLeaf) break
      // Existing entry might be a `file` if a path collides with a
      // folder name from another path — skip the rest of this path.
      if (child.kind !== "dir") break
      cur = child
    }
  }
  sortNode(root)
  return root
}

function sortNode(node: TreeNode): void {
  if (node.kind !== "dir") return
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1
    return a.path.localeCompare(b.path)
  })
  for (const c of node.children) sortNode(c)
}

// ---- editor ---------------------------------------------------------------

export function CodeEditor({
  initialFiles,
  defaultFile,
  fallbackLanguage,
  saveAction,
  rootFolder,
  height = "480px",
}: {
  initialFiles: FileEntry[]
  defaultFile: string
  // The user-editable folder root the tree is anchored at — e.g.
  // "function". New files are created relative to this folder.
  rootFolder: string
  // Language the runtime declared (e.g. "python"). Files whose
  // extension we don't recognise fall back to this.
  fallbackLanguage: string
  saveAction: (input: SaveInput) => Promise<{ error?: string } | void>
  // Total height (header + tree + editor). The editor body fills the
  // remaining space after the header bar.
  height?: string
}) {
  const router = useRouter()
  const { resolvedTheme } = useTheme()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Working set: existing-and-edited content, deleted-existing paths,
  // newly-created paths. Tracking origin lets us drop "create then
  // delete" cycles without round-tripping the server.
  const [files, setFiles] = useState<Record<string, FileEntry>>(() =>
    Object.fromEntries(initialFiles.map((f) => [f.path, f])),
  )
  const [originalContent, setOriginalContent] = useState<Record<string, string>>(
    () => Object.fromEntries(initialFiles.map((f) => [f.path, f.content])),
  )
  // Paths that existed on load and are pending delete on next save.
  const [deletedPaths, setDeletedPaths] = useState<Set<string>>(new Set())

  const [active, setActive] = useState<string>(() => {
    if (initialFiles.find((f) => f.path === defaultFile)) return defaultFile
    return initialFiles[0]?.path ?? ""
  })

  // Visible files = working set minus deletions.
  const visiblePaths = useMemo(
    () => Object.keys(files).filter((p) => !deletedPaths.has(p)).sort(),
    [files, deletedPaths],
  )

  const tree = useMemo(
    () => buildTree(rootFolder, visiblePaths),
    [rootFolder, visiblePaths],
  )

  const dirtyPaths = useMemo(() => {
    const set = new Set<string>()
    for (const p of visiblePaths) {
      const original = originalContent[p]
      const current = files[p]?.content ?? ""
      // New file (no original) counts as dirty.
      if (original === undefined) set.add(p)
      else if (current !== original) set.add(p)
    }
    return set
  }, [visiblePaths, files, originalContent])

  const isDirty = dirtyPaths.size > 0 || deletedPaths.size > 0

  function addFile() {
    const input = window.prompt(
      `New file path (relative to ${rootFolder}/):`,
      "",
    )
    if (!input) return
    const trimmed = input.trim().replace(/^\/+/, "")
    if (!trimmed) return
    if (trimmed.includes("..")) {
      setError("Path can't contain '..'")
      return
    }
    const fullPath = `${rootFolder}/${trimmed}`
    if (files[fullPath]) {
      setError(`${fullPath} already exists`)
      setActive(fullPath)
      return
    }
    setError(null)
    setFiles((prev) => ({
      ...prev,
      [fullPath]: { path: fullPath, content: "" },
    }))
    // If the user undelete-recreates by typing the same path, drop it
    // from the delete set.
    setDeletedPaths((prev) => {
      if (!prev.has(fullPath)) return prev
      const next = new Set(prev)
      next.delete(fullPath)
      return next
    })
    setActive(fullPath)
  }

  function removeFile(path: string) {
    if (!window.confirm(`Delete ${path}?`)) return
    setFiles((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })
    if (originalContent[path] !== undefined) {
      // Existing file — record for server-side delete on save.
      setDeletedPaths((prev) => {
        const next = new Set(prev)
        next.add(path)
        return next
      })
    }
    if (active === path) {
      const remaining = visiblePaths.filter((p) => p !== path)
      setActive(remaining[0] ?? "")
    }
  }

  const activeFile = active ? files[active] : undefined
  const language = active ? languageForPath(active, fallbackLanguage) : fallbackLanguage

  return (
    <div className="flex flex-col border" style={{ height }}>
      <div className="bg-muted/40 flex items-center justify-between border-b px-3 py-1.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono">{active || "—"}</span>
          {active && dirtyPaths.has(active) && (
            <span className="text-muted-foreground">• unsaved</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {error && (
            <span className="text-destructive text-xs" role="alert">
              {error}
            </span>
          )}
          <Button
            size="sm"
            disabled={pending || !isDirty}
            onClick={() =>
              startTransition(async () => {
                setError(null)
                const writes = Array.from(dirtyPaths).map((p) => ({
                  path: p,
                  content: files[p]!.content,
                }))
                const result = await saveAction({
                  files: writes,
                  deletes: Array.from(deletedPaths),
                })
                if (result?.error) {
                  setError(result.error)
                  return
                }
                // Successful save → folded changes become the new
                // "original" baseline; deletes vanish.
                setOriginalContent((prev) => {
                  const next = { ...prev }
                  for (const w of writes) next[w.path] = w.content
                  for (const p of deletedPaths) delete next[p]
                  return next
                })
                setDeletedPaths(new Set())
                router.refresh()
              })
            }
          >
            {pending ? "Deploying…" : "Deploy"}
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[14rem_1fr]">
        <FileTree
          tree={tree}
          active={active}
          dirty={dirtyPaths}
          onSelect={setActive}
          onAddFile={addFile}
          onDeleteFile={removeFile}
        />
        <div className="min-h-0">
          {activeFile ? (
            <Monaco
              height="100%"
              path={active}
              language={language}
              theme={resolvedTheme === "dark" ? "vs-dark" : "light"}
              value={activeFile.content}
              onChange={(v) =>
                setFiles((prev) => ({
                  ...prev,
                  [active]: { path: active, content: v ?? "" },
                }))
              }
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                scrollBeyondLastLine: false,
                renderLineHighlight: "line",
                tabSize: 2,
                automaticLayout: true,
              }}
            />
          ) : (
            <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
              No file selected. Click + to add one.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---- file tree ------------------------------------------------------------

function FileTree({
  tree,
  active,
  dirty,
  onSelect,
  onAddFile,
  onDeleteFile,
}: {
  tree: TreeNode
  active: string
  dirty: Set<string>
  onSelect: (path: string) => void
  onAddFile: () => void
  onDeleteFile: (path: string) => void
}) {
  return (
    <div className="bg-muted/20 flex min-h-0 flex-col border-r">
      <div className="bg-muted/30 flex items-center justify-between border-b px-2 py-1 text-xs">
        <span className="text-muted-foreground font-medium uppercase tracking-wide">
          Files
        </span>
        <button
          type="button"
          onClick={onAddFile}
          className="hover:bg-background/60 rounded px-1.5 py-0.5"
          title="Add file"
        >
          <Plus className="size-3.5" weight="bold" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        <TreeNodeView
          node={tree}
          depth={0}
          isRoot
          active={active}
          dirty={dirty}
          onSelect={onSelect}
          onDeleteFile={onDeleteFile}
        />
      </div>
    </div>
  )
}

function TreeNodeView({
  node,
  depth,
  isRoot,
  active,
  dirty,
  onSelect,
  onDeleteFile,
}: {
  node: TreeNode
  depth: number
  isRoot?: boolean
  active: string
  dirty: Set<string>
  onSelect: (path: string) => void
  onDeleteFile: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(true)
  if (node.kind === "file") {
    const isActive = node.path === active
    const isDirty = dirty.has(node.path)
    const name = node.path.split("/").pop() ?? node.path
    return (
      <div
        className={`group flex items-center gap-1 pr-1 font-mono text-xs ${
          isActive ? "bg-background" : "hover:bg-background/60"
        }`}
        style={{ paddingLeft: `${depth * 0.75 + 0.5}rem` }}
      >
        <button
          type="button"
          onClick={() => onSelect(node.path)}
          className={`flex flex-1 items-center gap-1.5 truncate py-1 text-left ${
            isActive ? "" : "text-muted-foreground"
          }`}
          title={node.path}
        >
          <FileIcon className="size-3.5 shrink-0" />
          <span className="truncate">{name}</span>
          {isDirty && <span className="text-muted-foreground">•</span>}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onDeleteFile(node.path)
          }}
          className="text-muted-foreground hover:text-destructive opacity-0 transition-opacity group-hover:opacity-100"
          title="Delete file"
        >
          <X className="size-3.5" weight="bold" />
        </button>
      </div>
    )
  }
  // directory
  const name = isRoot ? node.path : (node.path.split("/").pop() ?? node.path)
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="hover:bg-background/60 flex w-full items-center gap-1 py-1 pr-1 text-left font-mono text-xs"
        style={{ paddingLeft: `${depth * 0.75 + 0.25}rem` }}
        title={node.path}
      >
        {expanded ? (
          <CaretDown className="size-3 shrink-0" />
        ) : (
          <CaretRight className="size-3 shrink-0" />
        )}
        {expanded ? (
          <FolderOpen className="size-3.5 shrink-0" />
        ) : (
          <Folder className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{name}/</span>
      </button>
      {expanded && (
        <div>
          {node.children.length === 0 && (
            <div
              className="text-muted-foreground py-1 text-xs italic"
              style={{ paddingLeft: `${(depth + 1) * 0.75 + 0.5}rem` }}
            >
              empty
            </div>
          )}
          {node.children.map((child) => (
            <TreeNodeView
              key={child.path}
              node={child}
              depth={depth + 1}
              active={active}
              dirty={dirty}
              onSelect={onSelect}
              onDeleteFile={onDeleteFile}
            />
          ))}
        </div>
      )}
    </div>
  )
}
