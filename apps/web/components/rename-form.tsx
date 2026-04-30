"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

// Inline rename for any resource — used on detail pages of vms /
// agents / volumes / loadbalancers. Submits via a server action that
// the page provides; the slug is fixed and stays in the URL, only
// the display name changes.
//
// UX: the name is always rendered as an <input> styled to match the
// page's h1 — looks like static text by default, hover/focus reveal
// a thin border so the affordance is "click to edit". No Save /
// Cancel buttons:
//   - blur saves (server action) if value is non-empty and changed
//   - Enter blurs (commits)
//   - Escape reverts to the last-saved value and blurs
// Errors flash a small inline message and roll the value back so
// the next attempt starts clean.
export function RenameForm({
  initialName,
  action,
}: {
  initialName: string
  action: (formData: FormData) => Promise<{ error?: string } | void>
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [value, setValue] = useState(initialName)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Re-sync when the parent re-renders with a new server-side value
  // (e.g. after router.refresh() following a successful save).
  useEffect(() => {
    setValue(initialName)
  }, [initialName])

  const commit = (next: string) => {
    const trimmed = next.trim()
    if (!trimmed) {
      setValue(initialName)
      return
    }
    if (trimmed === initialName) return
    startTransition(async () => {
      setError(null)
      const fd = new FormData()
      fd.set("name", trimmed)
      const result = await action(fd)
      if (result && "error" in result && result.error) {
        setError(result.error)
        setValue(initialName)
        return
      }
      router.refresh()
    })
  }

  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => commit(value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            e.currentTarget.blur()
          } else if (e.key === "Escape") {
            setValue(initialName)
            // setTimeout so the value is in state before blur fires
            // commit() — otherwise commit reads the un-reverted value.
            setTimeout(() => e.currentTarget.blur(), 0)
          }
        }}
        disabled={pending}
        maxLength={200}
        spellCheck={false}
        // Width grows with content so the border doesn't look short.
        size={Math.max(value.length, 8)}
        aria-label="Name"
        className="text-2xl font-semibold bg-transparent border border-transparent rounded px-1 -mx-1 hover:border-input focus:border-input focus-visible:outline-none focus-visible:ring-0 disabled:opacity-60"
      />
      {error && (
        <span role="alert" className="text-destructive text-xs">
          {error}
        </span>
      )}
    </div>
  )
}
