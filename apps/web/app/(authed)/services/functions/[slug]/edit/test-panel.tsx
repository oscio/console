"use client"

import { useMemo, useState, useTransition } from "react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import type { FunctionRouteEntry } from "@/lib/api"

const METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
] as const
type Method = (typeof METHODS)[number]

export type InvocationResult = {
  status: number
  headers: Record<string, string>
  body: string
}

export function TestPanel({
  routes,
  invokeAction,
}: {
  routes: FunctionRouteEntry[]
  invokeAction: (input: {
    method: string
    path: string
    headers: Record<string, string>
    body: string
  }) => Promise<{ result?: InvocationResult; error?: string }>
}) {
  const [active, setActive] = useState<string>(() => routes[0]?.path ?? "/")
  const [pending, startTransition] = useTransition()
  // Keep one request-state record per route so switching routes
  // doesn't wipe what the user just typed.
  const [byRoute, setByRoute] = useState<Record<string, RouteState>>(() =>
    Object.fromEntries(
      routes.map((r) => [
        r.path,
        {
          method: "GET" as Method,
          headers: "",
          body: "",
          response: null,
          error: null,
        },
      ]),
    ),
  )

  const cur = useMemo(() => byRoute[active], [byRoute, active])

  function patch(
    routePath: string,
    update: Partial<RouteState>,
  ) {
    setByRoute((prev) => ({
      ...prev,
      [routePath]: {
        ...(prev[routePath] ?? defaultState()),
        ...update,
      },
    }))
  }

  function send() {
    if (!cur || !active) return
    startTransition(async () => {
      patch(active, { error: null })
      const headers = parseHeaders(cur.headers)
      if (headers.error) {
        patch(active, { error: headers.error })
        return
      }
      const result = await invokeAction({
        method: cur.method,
        path: active,
        headers: headers.value,
        body: cur.body,
      })
      if (result.error) {
        patch(active, { error: result.error })
        return
      }
      if (result.result) {
        patch(active, { response: result.result })
      }
    })
  }

  if (routes.length === 0) {
    return (
      <div className="text-muted-foreground border p-6 text-center text-xs">
        No routes discovered. Add a top-level <code>def</code> in a{" "}
        <code className="font-mono">function/*.py</code> file and Deploy.
      </div>
    )
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[14rem_1fr] border">
      <RouteList
        routes={routes}
        active={active}
        onSelect={setActive}
      />
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        {cur && (
          <RequestPanel
            path={active}
            state={cur}
            pending={pending}
            onChange={(u) => patch(active, u)}
            onSend={send}
          />
        )}
      </div>
    </div>
  )
}

// ---- subcomponents --------------------------------------------------------

type RouteState = {
  method: Method
  // raw text the user types for headers (one per line, `Key: value`).
  headers: string
  body: string
  response: InvocationResult | null
  error: string | null
}

function defaultState(): RouteState {
  return {
    method: "GET",
    headers: "",
    body: "",
    response: null,
    error: null,
  }
}

function RouteList({
  routes,
  active,
  onSelect,
}: {
  routes: FunctionRouteEntry[]
  active: string
  onSelect: (path: string) => void
}) {
  return (
    <div className="bg-muted/20 flex min-h-0 flex-col overflow-y-auto border-r">
      <div className="bg-muted/30 flex shrink-0 items-center justify-between border-b px-2 py-1 text-xs">
        <span className="text-muted-foreground font-medium uppercase tracking-wide">
          Routes
        </span>
      </div>
      <ul className="py-1">
        {routes.map((r) => (
          <li key={`${r.file}:${r.symbol}`}>
            <button
              type="button"
              onClick={() => onSelect(r.path)}
              className={`group flex w-full flex-col items-start px-3 py-1.5 text-left ${
                r.path === active ? "bg-background" : "hover:bg-background/60"
              }`}
              title={`${r.file}:${r.symbol}`}
            >
              <span className="font-mono text-xs">{r.path}</span>
              <span className="text-muted-foreground font-mono text-[11px]">
                {r.symbol}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function RequestPanel({
  path,
  state,
  pending,
  onChange,
  onSend,
}: {
  path: string
  state: RouteState
  pending: boolean
  onChange: (u: Partial<RouteState>) => void
  onSend: () => void
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Select
          value={state.method}
          onValueChange={(v) => onChange({ method: v as Method })}
        >
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {METHODS.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="bg-muted/40 flex-1 truncate rounded border px-3 py-1 font-mono text-xs">
          {path}
        </span>
        <Button onClick={onSend} disabled={pending} size="sm">
          {pending ? "Sending…" : "Send"}
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-2 divide-x">
        {/* request side */}
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-3">
          <Field
            label="Headers"
            hint="One per line, `Key: Value`. Host is set by the proxy."
          >
            <textarea
              className="border-input bg-background h-24 w-full resize-y border p-2 font-mono text-xs"
              value={state.headers}
              onChange={(e) => onChange({ headers: e.target.value })}
              placeholder="content-type: application/json"
            />
          </Field>
          <Field label="Body" hint="Plain text or JSON. Ignored for GET/HEAD.">
            <textarea
              className="border-input bg-background h-32 w-full resize-y border p-2 font-mono text-xs"
              value={state.body}
              onChange={(e) => onChange({ body: e.target.value })}
              placeholder={`{\n  "key": "value"\n}`}
            />
          </Field>
          {state.error && (
            <p
              role="alert"
              className="text-destructive border-destructive/30 bg-destructive/5 break-all border px-3 py-2 text-xs"
            >
              {state.error}
            </p>
          )}
        </div>

        {/* response side */}
        <div className="flex min-h-0 flex-col overflow-y-auto p-3">
          {state.response ? (
            <ResponseView response={state.response} />
          ) : (
            <p className="text-muted-foreground text-xs italic">
              No response yet — click Send.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function ResponseView({ response }: { response: InvocationResult }) {
  return (
    <div className="space-y-2 text-xs">
      <div>
        <Label className="text-muted-foreground text-[11px] uppercase">
          Status
        </Label>
        <p className="font-mono">
          <StatusPill status={response.status} /> {response.status}
        </p>
      </div>
      <div>
        <Label className="text-muted-foreground text-[11px] uppercase">
          Headers
        </Label>
        <pre className="bg-muted/40 max-h-32 overflow-auto whitespace-pre-wrap break-all border p-2 font-mono text-[11px]">
          {Object.entries(response.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n")}
        </pre>
      </div>
      <div>
        <Label className="text-muted-foreground text-[11px] uppercase">
          Body
        </Label>
        <pre className="bg-muted/40 max-h-64 overflow-auto whitespace-pre-wrap break-all border p-2 font-mono text-[11px]">
          {prettyBody(response)}
        </pre>
      </div>
    </div>
  )
}

function StatusPill({ status }: { status: number }) {
  const tone =
    status < 300
      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : status < 500
        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "bg-destructive/10 text-destructive"
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${tone}`}
    >
      {status < 300 ? "OK" : status < 500 ? "WARN" : "ERR"}
    </span>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-muted-foreground text-[11px] uppercase">
        {label}
      </Label>
      {children}
      {hint && (
        <p className="text-muted-foreground text-[11px]">{hint}</p>
      )}
    </div>
  )
}

// ---- helpers --------------------------------------------------------------

// One header per line, `Key: Value`. Empty / comment-leading lines
// ignored. Returns the parsed map or an error string.
function parseHeaders(
  raw: string,
): { error: string; value: Record<string, string> } {
  const out: Record<string, string> = {}
  let lineNum = 0
  for (const line of raw.split(/\r?\n/)) {
    lineNum++
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const idx = trimmed.indexOf(":")
    if (idx === -1) {
      return {
        error: `Line ${lineNum}: header lines need a colon ('Key: value').`,
        value: out,
      }
    }
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
  }
  return { error: "", value: out }
}

function prettyBody(response: InvocationResult): string {
  const ct = (
    response.headers["content-type"] || response.headers["Content-Type"] || ""
  ).toLowerCase()
  if (!response.body) return "(empty body)"
  if (ct.includes("application/json")) {
    try {
      return JSON.stringify(JSON.parse(response.body), null, 2)
    } catch {
      // fall through to raw
    }
  }
  return response.body
}
