"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

type Action = (formData: FormData) => Promise<{ error?: string } | void>

export function NewVmForm({ action }: { action: Action }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-sm font-medium"
      >
        Create VM
      </button>
    )
  }

  return (
    <form
      className="bg-card text-card-foreground space-y-3 rounded-md border p-4"
      action={(fd) =>
        startTransition(async () => {
          setError(null)
          const result = await action(fd)
          if (result?.error) {
            setError(result.error)
            return
          }
          setOpen(false)
          router.refresh()
        })
      }
    >
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">New VM</h3>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-muted-foreground hover:text-foreground text-xs"
        >
          Cancel
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground block text-xs">Name</span>
          <input
            name="name"
            required
            pattern="[a-z0-9]([-a-z0-9]*[a-z0-9])?"
            placeholder="my-vm"
            className="bg-background w-full rounded-md border px-2 py-1.5 text-sm"
          />
          <span className="text-muted-foreground block text-xs">
            Lowercase, digits, hyphens. Becomes the hostname.
          </span>
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground block text-xs">Storage</span>
          <input
            name="storageSize"
            placeholder="10Gi"
            defaultValue="10Gi"
            className="bg-background w-full rounded-md border px-2 py-1.5 text-sm"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground block text-xs">Image</span>
          <select
            name="imageType"
            defaultValue="base"
            className="bg-background w-full rounded-md border px-2 py-1.5 text-sm"
          >
            <option value="base">base</option>
            <option value="desktop">desktop</option>
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground block text-xs">Agent</span>
          <select
            name="agentType"
            defaultValue="hermes"
            className="bg-background w-full rounded-md border px-2 py-1.5 text-sm"
          >
            <option value="hermes">hermes</option>
            <option value="none">none</option>
          </select>
        </label>
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}

      <div className="flex justify-end gap-2">
        <button
          type="submit"
          disabled={pending}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 rounded-md px-3 py-1.5 text-sm font-medium"
        >
          {pending ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  )
}

export function DeleteVmButton({
  action,
  name,
}: {
  action: (formData: FormData) => Promise<void>
  name: string
}) {
  const [pending, startTransition] = useTransition()
  return (
    <form
      action={(fd) => {
        if (!confirm(`Delete VM "${name}"? This is irreversible.`)) return
        startTransition(() => action(fd))
      }}
    >
      <input type="hidden" name="name" value={name} />
      <button
        type="submit"
        disabled={pending}
        className="hover:bg-muted rounded-md border px-2 py-1 text-xs disabled:opacity-50"
      >
        {pending ? "Deleting…" : "Delete"}
      </button>
    </form>
  )
}
