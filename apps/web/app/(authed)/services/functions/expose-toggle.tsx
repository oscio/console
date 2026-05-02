"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"

// Owner-only public-URL toggle. On = the platform creates an
// HTTPRoute fronting the function at <slug>.fn.<domain>. There's no
// auth on the route — exposed means literally public, anyone with
// the URL can call.
export function ExposeToggle({
  initial,
  action,
  disabled,
  disabledReason,
}: {
  initial: boolean
  action: (exposed: boolean) => Promise<void>
  // External lock (e.g. "no prod image yet — Deploy first"). Combined
  // with the internal pending-transition lock so the select stays
  // unclickable while the server-action is in flight.
  disabled?: boolean
  disabledReason?: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [value, setValue] = useState<"on" | "off">(initial ? "on" : "off")

  return (
    <div className="flex items-center gap-2">
      <Select
        value={value}
        disabled={pending || disabled}
        onValueChange={(v) => {
          const next = v as "on" | "off"
          if (next === value) return
          const prev = value
          setValue(next)
          startTransition(async () => {
            try {
              await action(next === "on")
              router.refresh()
            } catch {
              setValue(prev)
            }
          })
        }}
      >
        <SelectTrigger className="h-7 w-32 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="off">Internal</SelectItem>
          <SelectItem value="on">Public URL</SelectItem>
        </SelectContent>
      </Select>
      {disabled && disabledReason && (
        <span className="text-muted-foreground text-xs">{disabledReason}</span>
      )}
    </div>
  )
}
