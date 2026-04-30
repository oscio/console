"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"

// Inline rename for any resource — used on detail pages of vms /
// agents / volumes / loadbalancers. Submits via a server action that
// the page provides; the slug is fixed and stays in the URL, only
// the display name changes.
//
// Editing toggles between a static label and an input + Save/Cancel.
// On success the page is refreshed so the title block re-renders
// with the new name (no client-side state mirror to drift).
export function RenameForm({
  initialName,
  action,
}: {
  initialName: string
  action: (formData: FormData) => Promise<{ error?: string } | void>
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(initialName)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  if (!editing) {
    return (
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">{initialName}</h1>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setValue(initialName)
            setError(null)
            setEditing(true)
          }}
        >
          Rename
        </Button>
      </div>
    )
  }

  return (
    <form
      className="flex items-center gap-2"
      action={(fd) =>
        startTransition(async () => {
          setError(null)
          const result = await action(fd)
          if (result?.error) {
            setError(result.error)
            return
          }
          setEditing(false)
          router.refresh()
        })
      }
    >
      <Input
        name="name"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={200}
        required
        autoFocus
        className="text-2xl font-semibold h-auto py-1"
      />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => {
          setEditing(false)
          setError(null)
        }}
      >
        Cancel
      </Button>
      {error && (
        <span role="alert" className="text-destructive text-xs">
          {error}
        </span>
      )}
    </form>
  )
}
