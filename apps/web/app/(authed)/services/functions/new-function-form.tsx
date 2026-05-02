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
import { FUNCTION_RUNTIMES, type FunctionRuntime } from "@/lib/api"

type Action = (formData: FormData) => Promise<{ error?: string } | void>

export function NewFunctionForm({ action }: { action: Action }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [runtime, setRuntime] = useState<FunctionRuntime>("python3.12")

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setError(null)
      }}
    >
      <DialogTrigger asChild>
        <Button>Create Function</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Function</DialogTitle>
          <DialogDescription>
            Phase 1 saves metadata only — picking a runtime now lets the
            future execution backend pick it up without re-creating.
          </DialogDescription>
        </DialogHeader>

        <form
          id="new-function-form"
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
          <Field id="fn-name" label="Name" hint="Display label. ID is auto-generated.">
            <Input
              id="fn-name"
              name="name"
              required
              maxLength={200}
              placeholder="image-resize"
            />
          </Field>

          <Field
            id="fn-runtime"
            label="Runtime"
            hint="Stored as metadata; execution lands in a later phase."
          >
            <input type="hidden" name="runtime" value={runtime} />
            <Select
              value={runtime}
              onValueChange={(v) => setRuntime(v as FunctionRuntime)}
            >
              <SelectTrigger id="fn-runtime" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FUNCTION_RUNTIMES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
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
          <Button form="new-function-form" type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create Function"}
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

export function DeleteFunctionButton({
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
          !confirm(`Delete function "${label}" (${slug})? This is irreversible.`)
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
