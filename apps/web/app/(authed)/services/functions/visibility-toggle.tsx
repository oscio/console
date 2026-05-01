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

// Owner-only visibility toggle. The server action grants or revokes
// the `user:* viewer` FGA tuple; the rest of the app reads visibility
// off the same tuple, so a refresh after the change picks up the new
// state across list + detail.
export function VisibilityToggle({
  initial,
  action,
}: {
  initial: boolean
  action: (isPublic: boolean) => Promise<void>
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [value, setValue] = useState<"public" | "private">(
    initial ? "public" : "private",
  )

  return (
    <Select
      value={value}
      disabled={pending}
      onValueChange={(v) => {
        const next = v as "public" | "private"
        if (next === value) return
        const prev = value
        setValue(next)
        startTransition(async () => {
          try {
            await action(next === "public")
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
        <SelectItem value="private">Private</SelectItem>
        <SelectItem value="public">Public</SelectItem>
      </SelectContent>
    </Select>
  )
}
