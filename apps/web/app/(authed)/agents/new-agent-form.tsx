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

export function NewAgentForm({ action }: { action: Action }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  // shadcn Select renders a Radix Listbox, not a native <select>, so
  // mirror its value into a hidden input for FormData.
  const [agentType, setAgentType] = useState<"hermes" | "openclaw">("hermes")

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setError(null)
      }}
    >
      <SheetTrigger asChild>
        <Button>Create Agent</Button>
      </SheetTrigger>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>New Agent</SheetTitle>
          <SheetDescription>
            Provisions a StatefulSet (1 replica) in your{" "}
            <code>resource-agent-…</code> namespace.
          </SheetDescription>
        </SheetHeader>

        <form
          id="new-agent-form"
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
            id="agent-name"
            label="Name"
            hint="A label just for you. The hostname is auto-generated."
          >
            <Input
              id="agent-name"
              name="name"
              required
              maxLength={200}
              placeholder="My research agent"
            />
          </Field>

          <Field
            id="agent-type"
            label="Type"
            hint="Picks which entrypoint-<type>.sh runs inside the pod."
          >
            <input type="hidden" name="agentType" value={agentType} />
            <Select
              value={agentType}
              onValueChange={(v) => setAgentType(v as "hermes" | "openclaw")}
            >
              <SelectTrigger id="agent-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hermes">hermes</SelectItem>
                <SelectItem value="openclaw">openclaw</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field
            id="agent-storage"
            label="Storage"
            hint="PersistentVolumeClaim size for /home/agent."
          >
            <Input
              id="agent-storage"
              name="storageSize"
              defaultValue="10Gi"
              placeholder="10Gi"
            />
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
          <Button form="new-agent-form" type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create Agent"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
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

export function DeleteAgentButton({
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
        if (
          !confirm(`Delete agent "${label}" (${slug})? This is irreversible.`)
        )
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
