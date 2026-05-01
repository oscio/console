"use client"

import { useState, useTransition } from "react"
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

// Lambda-style: one repo = one function = one URL. The handler does
// its own internal routing if it cares about path/method, so the Test
// tab is just a single Postman-style panel — pick method, set path
// (handler sees it as event.requestContext.http.path), set headers
// and body, send.
export function TestPanel({
  invokeAction,
}: {
  invokeAction: (input: {
    method: string
    path: string
    headers: Record<string, string>
    body: string
  }) => Promise<{ result?: InvocationResult; error?: string }>
}) {
  const [method, setMethod] = useState<Method>("GET")
  const [path, setPath] = useState("/")
  const [headersText, setHeadersText] = useState("")
  const [body, setBody] = useState("")
  const [response, setResponse] = useState<InvocationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function send() {
    startTransition(async () => {
      setError(null)
      const headers = parseHeaders(headersText)
      if (headers.error) {
        setError(headers.error)
        return
      }
      const result = await invokeAction({
        method,
        path: path || "/",
        headers: headers.value,
        body,
      })
      if (result.error) {
        setError(result.error)
        return
      }
      if (result.result) setResponse(result.result)
    })
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-2 divide-x border">
      {/* request side */}
      <div className="flex min-h-0 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <Select
            value={method}
            onValueChange={(v) => setMethod(v as Method)}
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
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/"
            className="font-mono text-xs"
          />
          <Button onClick={send} disabled={pending} size="sm">
            {pending ? "Sending…" : "Send"}
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
          <Field
            label="Headers"
            hint="One per line, `Key: Value`. Host is set by the proxy."
          >
            <textarea
              className="border-input bg-background h-24 w-full resize-y border p-2 font-mono text-xs"
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              placeholder="content-type: application/json"
            />
          </Field>
          <Field label="Body" hint="Plain text or JSON. Ignored for GET/HEAD.">
            <textarea
              className="border-input bg-background h-32 w-full resize-y border p-2 font-mono text-xs"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={`{\n  "key": "value"\n}`}
            />
          </Field>
          {error && (
            <p
              role="alert"
              className="text-destructive border-destructive/30 bg-destructive/5 break-all border px-3 py-2 text-xs"
            >
              {error}
            </p>
          )}
        </div>
      </div>

      {/* response side */}
      <div className="flex min-h-0 flex-col overflow-y-auto p-3">
        {response ? (
          <ResponseView response={response} />
        ) : (
          <p className="text-muted-foreground text-xs italic">
            No response yet — click Send.
          </p>
        )}
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
      {hint && <p className="text-muted-foreground text-[11px]">{hint}</p>}
    </div>
  )
}

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
