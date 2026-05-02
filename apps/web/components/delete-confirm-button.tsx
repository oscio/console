"use client"

import { type ReactNode, useState, useTransition } from "react"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"

type Action = (formData: FormData) => void | Promise<unknown>

export function DeleteConfirmButton({
  action,
  hiddenFields,
  title,
  description,
  disabled,
  disabledReason,
  triggerLabel = "Delete",
  pendingLabel = "Deleting…",
  confirmLabel = "Delete",
}: {
  action: Action
  hiddenFields: Record<string, string>
  title: string
  description: ReactNode
  disabled?: boolean
  disabledReason?: string
  triggerLabel?: string
  pendingLabel?: string
  confirmLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending || disabled}
        onClick={() => setOpen(true)}
        className="text-destructive hover:text-destructive"
        title={disabled ? disabledReason : undefined}
      >
        {pending ? pendingLabel : triggerLabel}
      </Button>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="outline"
              disabled={pending}
              className="text-destructive hover:text-destructive"
              onClick={() => {
                const fd = new FormData()
                for (const [k, v] of Object.entries(hiddenFields)) {
                  fd.set(k, v)
                }
                startTransition(async () => {
                  await action(fd)
                  setOpen(false)
                })
              }}
            >
              {pending ? pendingLabel : confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
