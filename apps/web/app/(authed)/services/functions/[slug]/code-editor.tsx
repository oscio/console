"use client"

import { useState, useTransition } from "react"
import dynamic from "next/dynamic"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { Button } from "@workspace/ui/components/button"

// Monaco's React wrapper pulls a fairly heavy bundle (200kB+ gzipped)
// and references `window`, so it has to be client-only via dynamic.
// SSR is disabled — the editor only matters once the user reaches the
// detail page.
const Monaco = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="text-muted-foreground flex h-[420px] items-center justify-center text-xs">
      Loading editor…
    </div>
  ),
})

export function CodeEditor({
  initialContent,
  language,
  path,
  saveAction,
}: {
  initialContent: string
  language: string
  // The file path is shown in the header strip — purely informational
  // since the user can't pick a different file from the console.
  path: string
  saveAction: (content: string) => Promise<{ error?: string } | void>
}) {
  const router = useRouter()
  const { resolvedTheme } = useTheme()
  const [pending, startTransition] = useTransition()
  const [content, setContent] = useState(initialContent)
  const [savedContent, setSavedContent] = useState(initialContent)
  const [error, setError] = useState<string | null>(null)
  const dirty = content !== savedContent

  return (
    <div className="border">
      <div className="bg-muted/40 flex items-center justify-between border-b px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs">{path}</span>
          {dirty && (
            <span className="text-muted-foreground text-xs">• unsaved</span>
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
            disabled={pending || !dirty}
            onClick={() =>
              startTransition(async () => {
                setError(null)
                const result = await saveAction(content)
                if (result?.error) {
                  setError(result.error)
                  return
                }
                setSavedContent(content)
                router.refresh()
              })
            }
          >
            {pending ? "Saving…" : "Deploy"}
          </Button>
        </div>
      </div>
      <Monaco
        height="420px"
        language={language}
        theme={resolvedTheme === "dark" ? "vs-dark" : "light"}
        value={content}
        onChange={(v) => setContent(v ?? "")}
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
  )
}
