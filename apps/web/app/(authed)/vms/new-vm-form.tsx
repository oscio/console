"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@workspace/ui/components/dialog"

type Action = (formData: FormData) => Promise<{ error?: string } | void>

export function NewVmForm({ action }: { action: Action }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  // shadcn Select doesn't bubble to the underlying form on submit (it
  // renders a Radix Listbox, not a native <select>). Mirror its value
  // into a hidden input so server-action FormData picks it up.
  const [imageType, setImageType] = useState<"base" | "desktop">("base")

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setError(null)
      }}
    >
      <DialogTrigger asChild>
        <Button>Create VM</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New VM</DialogTitle>
          <DialogDescription>
            Provisions a StatefulSet (1 replica) in your{" "}
            <code>resource-vm-…</code> namespace.
          </DialogDescription>
        </DialogHeader>

        <form
          id="new-vm-form"
          className="space-y-4"
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
          <Field
            id="vm-name"
            label="Name"
            hint="A label just for you. The hostname is auto-generated."
          >
            <Input
              id="vm-name"
              name="name"
              required
              maxLength={200}
              placeholder="My dev box"
            />
          </Field>

          <Field
            id="vm-image"
            label="Image"
            hint="Base = code-server + agent runtime. Desktop adds XFCE + KasmVNC."
          >
            <input type="hidden" name="imageType" value={imageType} />
            <Select
              value={imageType}
              onValueChange={(v) => setImageType(v as "base" | "desktop")}
            >
              <SelectTrigger id="vm-image" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="base">base</SelectItem>
                <SelectItem value="desktop">desktop</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field
            id="vm-storage"
            label="Storage"
            hint="PersistentVolumeClaim size for /home/agent."
          >
            <Input
              id="vm-storage"
              name="storageSize"
              defaultValue="10Gi"
              placeholder="10Gi"
            />
          </Field>

          {error && (
            <p
              role="alert"
              className="text-destructive border-destructive/30 bg-destructive/5 border px-3 py-2 text-sm"
            >
              {error}
            </p>
          )}
        </form>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button form="new-vm-form" type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create VM"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  )
}

export function DeleteVmButton({
  action,
  slug,
  label,
}: {
  action: (formData: FormData) => Promise<void>
  slug: string
  label: string
}) {
  const [pending, startTransition] = useTransition()
  return (
    <form
      action={(fd) => {
        if (!confirm(`Delete VM "${label}" (${slug})? This is irreversible.`))
          return
        startTransition(() => action(fd))
      }}
    >
      <input type="hidden" name="slug" value={slug} />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={pending}
        className="text-destructive hover:text-destructive"
      >
        {pending ? "Deleting…" : "Delete"}
      </Button>
    </form>
  )
}
