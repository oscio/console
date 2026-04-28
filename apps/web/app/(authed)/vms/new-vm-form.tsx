"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@workspace/ui/components/sheet"

type Action = (formData: FormData) => Promise<{ error?: string } | void>

export function NewVmForm({ action }: { action: Action }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setError(null)
      }}
    >
      <SheetTrigger asChild>
        <Button>Create VM</Button>
      </SheetTrigger>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>New VM</SheetTitle>
          <SheetDescription>
            Provisions a StatefulSet (1 replica) in your <code>resource-vm-…</code> namespace.
          </SheetDescription>
        </SheetHeader>

        <form
          id="new-vm-form"
          className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
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
            label="Name"
            hint="Lowercase letters, digits, hyphens. Must start with a letter. Becomes the VM hostname."
          >
            <Input
              name="name"
              required
              pattern="[a-z]([-a-z0-9]*[a-z0-9])?"
              placeholder="my-vm"
            />
          </Field>

          <Field
            label="Image"
            hint="Base = code-server + agent runtime. Desktop adds XFCE + KasmVNC."
          >
            <Select name="imageType" defaultValue="base">
              <option value="base">base</option>
              <option value="desktop">desktop</option>
            </Select>
          </Field>

          <Field
            label="Agent"
            hint="The in-VM agent runtime. `none` runs the sandbox image without an agent."
          >
            <Select name="agentType" defaultValue="hermes">
              <option value="hermes">hermes</option>
              <option value="none">none</option>
            </Select>
          </Field>

          <Field label="Storage" hint="PersistentVolumeClaim size for /home/agent.">
            <Input name="storageSize" defaultValue="10Gi" placeholder="10Gi" />
          </Field>

          {error && (
            <p
              role="alert"
              className="text-destructive border-destructive/30 bg-destructive/5 rounded-md border px-3 py-2 text-sm"
            >
              {error}
            </p>
          )}
        </form>

        <SheetFooter>
          <SheetClose asChild>
            <Button variant="outline" disabled={pending}>
              Cancel
            </Button>
          </SheetClose>
          <Button form="new-vm-form" type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create VM"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
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
    <label className="block space-y-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-muted-foreground block text-xs">{hint}</span>}
    </label>
  )
}

function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className="border-input bg-background focus-visible:ring-ring h-9 w-full rounded-md border px-3 text-sm focus-visible:ring-1 focus-visible:outline-none"
    />
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
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Deleting…" : "Delete"}
      </Button>
    </form>
  )
}
