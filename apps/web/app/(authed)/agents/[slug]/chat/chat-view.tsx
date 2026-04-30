"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { Button } from "@workspace/ui/components/button"
import { CopyableId } from "@/components/copyable-id"

// Strip ANSI escape sequences (CSI + a few common alts). Tool output
// from shell commands routinely includes color/cursor codes that
// render as `[31m`-style garbage in <pre>. Stripping is the cheapest
// path to readable output; full color rendering would need a lib.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "")
}

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

type TaskMeta = {
  task_id: string
  status: "running" | "done" | "failed" | "interrupted"
  started_at?: number
}

export function ChatView({
  slug,
  sessionId,
}: {
  slug: string
  sessionId: string
}) {
  // Events for tasks that have already finished — loaded once on
  // mount, stays put across new prompts.
  const [historyEvents, setHistoryEvents] = useState<Event[]>([])
  // Events for the currently in-flight task — replaced wholesale on
  // every poll tick; merged into history once the task terminates.
  const [liveEvents, setLiveEvents] = useState<Event[]>([])
  const [prompt, setPrompt] = useState("")
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const logRef = useRef<HTMLDivElement | null>(null)

  const events = loaded ? [...historyEvents, ...liveEvents] : []

  // Auto-scroll to the latest event whenever the log changes.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [events.length])

  // Backfill the chat with prior tasks' events on mount so the user
  // sees the full session, not just whatever came after a refresh.
  // The wrapper exposes /tasks?session_id=… for the meta listing and
  // /tasks/<id> for full events; we walk them in chronological order.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(slug)}/chat/tasks?session_id=${encodeURIComponent(sessionId)}`,
          { cache: "no-store" },
        )
        if (!res.ok) throw new Error(`tasks list ${res.status}`)
        const metas = (await res.json()) as TaskMeta[]
        const finished = metas
          .filter((m) => TERMINAL.has(m.status))
          .sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0))
        const all: Event[] = []
        for (const m of finished) {
          const r = await fetch(
            `/api/agents/${encodeURIComponent(slug)}/chat/tasks/${encodeURIComponent(m.task_id)}`,
            { cache: "no-store" },
          )
          if (!r.ok) continue
          const task = (await r.json()) as Task
          for (const ev of task.events ?? []) all.push(ev)
        }
        if (!cancelled) {
          setHistoryEvents(all)
          setLoaded(true)
        }
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message)
          setLoaded(true)
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [slug, sessionId])

  // Poll the active task. Stops when the task hits a terminal state
  // or the component unmounts. We re-fetch the *whole* events array
  // each tick — the wrapper's response includes the full backlog —
  // and on terminal, fold the live events into history so they stay
  // visible after the next prompt clears liveEvents.
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
        setLiveEvents(task.events ?? [])
        if (TERMINAL.has(task.status)) {
          setHistoryEvents((prev) => [...prev, ...(task.events ?? [])])
          setLiveEvents([])
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
        <p className="text-muted-foreground/60 text-xs">
          task <CopyableId id={String(ev.task_id ?? "")} />
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
    case "tool.result": {
      const output = stripAnsi(String(ev.output ?? ""))
      const failed =
        typeof ev.exit_code === "number" && ev.exit_code !== 0
      return (
        <div className="my-1">
          <p className="text-muted-foreground text-xs">
            ← {String(ev.name ?? "?")}
            {failed ? ` (exit ${ev.exit_code})` : ""}
          </p>
          {output && (
            <pre className="bg-muted/40 mt-0.5 overflow-x-auto rounded px-2 py-1 font-mono text-xs whitespace-pre-wrap break-words">
              {output}
            </pre>
          )}
        </div>
      )
    }
    case "task.done":
      // Silenced — message stream halt is itself the end-of-turn
      // signal. The event still lands in events.jsonl for debugging.
      return null
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
