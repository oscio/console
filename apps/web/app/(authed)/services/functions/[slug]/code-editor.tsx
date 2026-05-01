"use client"

import { useMemo, useState, useTransition } from "react"
import dynamic from "next/dynamic"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
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
type DirNode = Extract<TreeNode, { kind: "dir" }>

// Build a folder tree rooted at `rootFolder`. Only paths under that
// folder are nested in; everything else is dropped. Implicit folders
// (those that only exist because a file path contains them) get
// generated as `dir` nodes.
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
  rootFolder: string
  fallbackLanguage: string
  saveAction: (input: SaveInput) => Promise<{ error?: string } | void>
  height?: string
}) {
  const router = useRouter()
  const { resolvedTheme } = useTheme()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [files, setFiles] = useState<Record<string, FileEntry>>(() =>
    Object.fromEntries(initialFiles.map((f) => [f.path, f])),
  )
  const [originalContent, setOriginalContent] = useState<Record<string, string>>(
    () => Object.fromEntries(initialFiles.map((f) => [f.path, f.content])),
  )
  const [deletedPaths, setDeletedPaths] = useState<Set<string>>(new Set())

  const [active, setActive] = useState<string>(() => {
    if (initialFiles.find((f) => f.path === defaultFile)) return defaultFile
    return initialFiles[0]?.path ?? ""
  })

  // Dialog state — replaces window.prompt / window.confirm so the
  // create / delete flow stays inside the editor's UI shell.
  const [newFileOpen, setNewFileOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

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
      if (original === undefined) set.add(p)
      else if (current !== original) set.add(p)
    }
    return set
  }, [visiblePaths, files, originalContent])

  const isDirty = dirtyPaths.size > 0 || deletedPaths.size > 0

  function commitNewFile(rawPath: string): string | null {
    const trimmed = rawPath.trim().replace(/^\/+/, "")
    if (!trimmed) return "Path is required"
    if (trimmed.includes("..")) return "Path can't contain '..'"
    const fullPath = `${rootFolder}/${trimmed}`
    if (files[fullPath] && !deletedPaths.has(fullPath)) {
      return `${fullPath} already exists`
    }
    setFiles((prev) => ({
      ...prev,
      [fullPath]: { path: fullPath, content: "" },
    }))
    setDeletedPaths((prev) => {
      if (!prev.has(fullPath)) return prev
      const next = new Set(prev)
      next.delete(fullPath)
      return next
    })
    setActive(fullPath)
    return null
  }

  function confirmDelete(path: string) {
    setFiles((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })
    if (originalContent[path] !== undefined) {
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
    setPendingDelete(null)
  }

  const activeFile = active ? files[active] : undefined
  const language = active
    ? languageForPath(active, fallbackLanguage)
    : fallbackLanguage

  return (
    <div
      className="flex min-h-0 min-w-0 flex-col overflow-hidden border"
      style={{ height }}
    >
      <div className="bg-muted/40 flex shrink-0 items-center justify-between border-b px-3 py-1.5">
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

      {/* Body lives inside a relatively-positioned container with the
          editor pinned via inset-0. Pinning takes Monaco out of normal
          flow so any layout race during sidebar toggles or window
          resizes can't push it past the box. */}
      <div className="relative min-h-0 min-w-0 flex-1">
        <div className="absolute inset-0 grid grid-cols-[14rem_1fr]">
          <FileTree
            tree={tree}
            active={active}
            dirty={dirtyPaths}
            onSelect={setActive}
            onAddFile={() => setNewFileOpen(true)}
            onDeleteFile={setPendingDelete}
          />
          <div className="min-h-0 min-w-0 overflow-hidden">
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

      <NewFileDialog
        open={newFileOpen}
        onOpenChange={setNewFileOpen}
        rootFolder={rootFolder}
        onSubmit={commitNewFile}
      />
      <DeleteFileDialog
        path={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete && confirmDelete(pendingDelete)}
      />
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
  tree: DirNode
  active: string
  dirty: Set<string>
  onSelect: (path: string) => void
  onAddFile: () => void
  onDeleteFile: (path: string) => void
}) {
  return (
    <div className="bg-muted/20 flex min-h-0 min-w-0 flex-col overflow-hidden border-r">
      <div className="bg-muted/30 flex shrink-0 items-center justify-between border-b px-2 py-1 text-xs">
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

// ---- dialogs --------------------------------------------------------------

function NewFileDialog({
  open,
  onOpenChange,
  rootFolder,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rootFolder: string
  onSubmit: (path: string) => string | null
}) {
  const [path, setPath] = useState("")
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) {
          setPath("")
          setError(null)
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New file</DialogTitle>
          <DialogDescription>
            Path is relative to{" "}
            <code className="font-mono">{rootFolder}/</code>. Use slashes
            to put the file inside a subfolder — folders are created on
            demand.
          </DialogDescription>
        </DialogHeader>

        <form
          id="new-file-form"
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            const result = onSubmit(path)
            if (result) {
              setError(result)
              return
            }
            setPath("")
            setError(null)
            onOpenChange(false)
          }}
        >
          <Label htmlFor="new-file-path">Path</Label>
          <Input
            id="new-file-path"
            autoFocus
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="handlers/foo.py"
          />
          {error && (
            <p
              role="alert"
              className="text-destructive border-destructive/30 bg-destructive/5 border px-3 py-2 text-sm"
            >
              {error}
            </p>
          )}
        </form>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button form="new-file-form" type="submit">
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeleteFileDialog({
  path,
  onCancel,
  onConfirm,
}: {
  path: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={path !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete file?</DialogTitle>
          <DialogDescription>
            <code className="font-mono break-all">{path}</code>
            <br />
            This stages the delete — the file is removed from the repo
            on the next Deploy.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="outline"
            className="text-destructive hover:text-destructive"
            onClick={onConfirm}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
