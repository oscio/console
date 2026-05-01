"use client"

import { useState, useTransition } from "react"
import dynamic from "next/dynamic"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { Button } from "@workspace/ui/components/button"

// Monaco's React wrapper pulls a heavy bundle and references `window`
// so it's client-only via dynamic import. SSR is unnecessary — the
// editor only matters once the user lands on the detail page.
const Monaco = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="text-muted-foreground flex h-[480px] items-center justify-center text-xs">
      Loading editor…
    </div>
  ),
})

type FileEntry = { path: string; content: string }

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

export function CodeEditor({
  initialFiles,
  defaultFile,
  fallbackLanguage,
  saveAction,
}: {
  initialFiles: FileEntry[]
  defaultFile: string
  // Language the runtime declared (e.g. "python"). Files whose
  // extension we don't recognise fall back to this.
  fallbackLanguage: string
  saveAction: (
    files: FileEntry[],
  ) => Promise<{ error?: string } | void>
}) {
  const router = useRouter()
  const { resolvedTheme } = useTheme()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Per-file content + savedContent (for dirty tracking). Editing one
  // file leaves the others untouched until save.
  const [files, setFiles] = useState<Record<string, FileEntry>>(() =>
    Object.fromEntries(initialFiles.map((f) => [f.path, f])),
  )
  const [saved, setSaved] = useState<Record<string, string>>(() =>
    Object.fromEntries(initialFiles.map((f) => [f.path, f.content])),
  )
  const initialActive =
    initialFiles.find((f) => f.path === defaultFile)?.path ??
    initialFiles[0]?.path ??
    ""
  const [active, setActive] = useState<string>(initialActive)

  const dirtyPaths = Object.keys(files).filter(
    (p) => files[p]!.content !== saved[p],
  )
  const isDirty = dirtyPaths.length > 0

  if (!active) {
    return (
      <div className="text-muted-foreground border p-6 text-center text-xs">
        No editable files in this function.
      </div>
    )
  }

  const activeFile = files[active]!
  const language = languageForPath(active, fallbackLanguage)

  return (
    <div className="border">
      <div className="bg-muted/40 flex items-center justify-between border-b px-3 py-1.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono">{active}</span>
          {dirtyPaths.includes(active) && (
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
                const changed = dirtyPaths.map((p) => ({
                  path: p,
                  content: files[p]!.content,
                }))
                const result = await saveAction(changed)
                if (result?.error) {
                  setError(result.error)
                  return
                }
                setSaved((prev) => {
                  const next = { ...prev }
                  for (const f of changed) next[f.path] = f.content
                  return next
                })
                router.refresh()
              })
            }
          >
            {pending ? "Deploying…" : "Deploy"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-[12rem_1fr]">
        <FileTree
          paths={Object.keys(files).sort((a, b) => {
            // Pin defaultFile first, like the API ordering.
            if (a === defaultFile) return -1
            if (b === defaultFile) return 1
            return a.localeCompare(b)
          })}
          active={active}
          dirty={new Set(dirtyPaths)}
          onSelect={setActive}
        />
        <Monaco
          height="480px"
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
      </div>
    </div>
  )
}

function FileTree({
  paths,
  active,
  dirty,
  onSelect,
}: {
  paths: string[]
  active: string
  dirty: Set<string>
  onSelect: (path: string) => void
}) {
  return (
    <ul className="bg-muted/20 border-r">
      {paths.map((p) => {
        const name = p.split("/").pop() ?? p
        const isActive = p === active
        return (
          <li key={p}>
            <button
              type="button"
              onClick={() => onSelect(p)}
              className={`w-full px-3 py-1.5 text-left font-mono text-xs ${
                isActive
                  ? "bg-background"
                  : "hover:bg-background/60 text-muted-foreground"
              }`}
              title={p}
            >
              {name}
              {dirty.has(p) && (
                <span className="text-muted-foreground ml-1">•</span>
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
