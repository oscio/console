"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@workspace/ui/components/button"
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
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"

type Action = (formData: FormData) => Promise<{ error?: string } | void>

export function NewAgentForm({ action }: { action: Action }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  // shadcn Select renders a Radix Listbox, not a native <select>, so
  // mirror its value into a hidden input for FormData.
  const [agentType, setAgentType] = useState<"hermes" | "zeroclaw">("hermes")

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setError(null)
      }}
    >
      <DialogTrigger asChild>
        <Button>Create Agent</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Agent</DialogTitle>
          <DialogDescription>
            Provisions a StatefulSet (1 replica) in the shared{" "}
            <code>resource</code> namespace. State is ephemeral —
            sessions are wiped on pod restart.
          </DialogDescription>
        </DialogHeader>

        <form
          id="new-agent-form"
          className="space-y-5"
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
            hint="Selects which adapter the FastAPI wrapper dispatches to."
          >
            <input type="hidden" name="agentType" value={agentType} />
            <Select
              value={agentType}
              onValueChange={(v) => setAgentType(v as "hermes" | "zeroclaw")}
            >
              <SelectTrigger id="agent-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hermes">hermes</SelectItem>
                <SelectItem value="zeroclaw">zeroclaw</SelectItem>
              </SelectContent>
            </Select>
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
          <Button form="new-agent-form" type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create Agent"}
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

export function DeleteAgentButton({
  action,
  slug,
  label,
  disabled,
}: {
  action: (formData: FormData) => Promise<void>
  slug: string
  label: string
  disabled?: boolean
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
        disabled={pending || disabled}
        className="text-destructive hover:text-destructive"
        title={disabled ? "Agent is attached to a VM. Delete the VM first." : undefined}
      >
        {pending ? "Deleting…" : "Delete"}
      </Button>
    </form>
  )
}
