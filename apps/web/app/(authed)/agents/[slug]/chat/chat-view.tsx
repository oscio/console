"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { Button } from "@workspace/ui/components/button"

// Minimal chat surface. Each prompt → POST /tasks → poll GET /tasks/<id>
// until terminal state. Events are appended to the on-screen log as
// they show up. No streaming yet — polling keeps the contract simple
// while the wrapper / adapter event shapes settle. SSE swap-in lives
// at the same /tasks/<id>/stream endpoint when we want lower latency.

type Event = {
  ts: number
  type: string
  // Adapter events are loose-typed.
  [key: string]: unknown
}

type Task = {
  task_id: string
  status: "running" | "done" | "failed" | "interrupted"
  events?: Event[]
}

const TERMINAL = new Set(["done", "failed", "interrupted"])

export function ChatView({
  slug,
  sessionId,
}: {
  slug: string
  sessionId: string
}) {
  const [events, setEvents] = useState<Event[]>([])
  const [prompt, setPrompt] = useState("")
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [taskId, setTaskId] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)

  // Auto-scroll to the latest event whenever the log changes.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [events])

  // Poll the active task. Stops when the task hits a terminal state
  // or the component unmounts. We re-fetch the *whole* events array
  // each tick — the wrapper's response includes the full backlog,
  // so dedup/append cleverness isn't needed.
  useEffect(() => {
    if (!taskId) return
    let cancelled = false
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(slug)}/chat/tasks/${encodeURIComponent(taskId)}`,
          { cache: "no-store" },
        )
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          throw new Error(`poll failed: ${res.status} ${text}`)
        }
        const task = (await res.json()) as Task
        if (cancelled) return
        setEvents(task.events ?? [])
        if (TERMINAL.has(task.status)) {
          setTaskId(null)
          return
        }
        setTimeout(tick, 1000)
      } catch (e) {
        if (cancelled) return
        setError((e as Error).message)
        setTaskId(null)
      }
    }
    tick()
    return () => {
      cancelled = true
    }
  }, [slug, taskId])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const text = prompt.trim()
    if (!text || taskId) return
    setPrompt("")
    setError(null)
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(slug)}/chat/tasks`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ session_id: sessionId, prompt: text }),
          },
        )
        if (!res.ok) {
          const tx = await res.text().catch(() => "")
          throw new Error(`task create failed: ${res.status} ${tx}`)
        }
        const data = (await res.json()) as { task_id: string }
        setTaskId(data.task_id)
      } catch (e) {
        setError((e as Error).message)
      }
    })
  }

  const cancel = async () => {
    if (!taskId) return
    await fetch(
      `/api/agents/${encodeURIComponent(slug)}/chat/tasks/${encodeURIComponent(taskId)}/cancel`,
      { method: "POST" },
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden">
      <div
        ref={logRef}
        className="border bg-background flex-1 overflow-y-auto p-3 font-mono text-sm"
      >
        {events.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            Send a prompt to start.
          </p>
        ) : (
          events.map((ev, i) => <EventRow key={i} ev={ev} />)
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="text-destructive border-destructive/30 bg-destructive/5 border px-3 py-2 text-sm"
        >
          {error}
        </p>
      )}

      <form onSubmit={submit} className="flex gap-2">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={taskId ? "Agent is working…" : "Type a prompt and press ⌘/Ctrl+Enter."}
          disabled={!!taskId}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              submit(e as unknown as React.FormEvent)
            }
          }}
          rows={3}
          className="border bg-background flex-1 resize-none p-2 text-sm font-mono disabled:opacity-50"
        />
        <div className="flex flex-col gap-2">
          <Button
            type="submit"
            disabled={!!taskId || pending || !prompt.trim()}
          >
            {pending ? "Starting…" : "Send"}
          </Button>
          {taskId && (
            <Button type="button" variant="outline" onClick={cancel}>
              Cancel
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}

function EventRow({ ev }: { ev: Event }) {
  switch (ev.type) {
    case "task.started":
      return (
        <p className="text-muted-foreground text-xs italic">
          — task started ({String(ev.task_id ?? "").slice(0, 8)}…)
        </p>
      )
    case "message": {
      const role = String(ev.role ?? "assistant")
      const content = String(ev.content ?? "")
      return (
        <div className="my-2">
          <span
            className={`text-xs uppercase tracking-wide ${
              role === "user"
                ? "text-blue-600"
                : role === "assistant"
                  ? "text-emerald-600"
                  : "text-muted-foreground"
            }`}
          >
            {role}
          </span>
          <pre className="whitespace-pre-wrap break-words">{content}</pre>
        </div>
      )
    }
    case "tool.call":
      return (
        <p className="text-muted-foreground text-xs">
          → tool <span className="font-bold">{String(ev.name ?? "?")}</span>{" "}
          <span className="opacity-70">{JSON.stringify(ev.input)}</span>
        </p>
      )
    case "tool.result":
      return (
        <p className="text-muted-foreground text-xs">
          ← {String(ev.name ?? "?")}: {String(ev.output ?? "").slice(0, 200)}
          {typeof ev.exit_code === "number" && ev.exit_code !== 0
            ? ` (exit ${ev.exit_code})`
            : ""}
        </p>
      )
    case "task.done":
      return (
        <p className="text-muted-foreground text-xs italic">
          — done
        </p>
      )
    case "task.error":
      return (
        <p className="text-destructive text-xs">
          ✗ {String(ev.error ?? "")}
        </p>
      )
    default:
      return (
        <p className="text-muted-foreground text-xs opacity-50">
          [{ev.type}] {JSON.stringify(ev)}
        </p>
      )
  }
}
