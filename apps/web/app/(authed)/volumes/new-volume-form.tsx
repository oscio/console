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
import { Slider } from "@workspace/ui/components/slider"

type Action = (formData: FormData) => Promise<{ error?: string } | void>

const SIZE = { min: 1, max: 20, step: 1, recommended: 1 }

export function NewVolumeForm({ action }: { action: Action }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [size, setSize] = useState(SIZE.recommended)

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setError(null)
      }}
    >
      <DialogTrigger asChild>
        <Button>Create Volume</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Volume</DialogTitle>
          <DialogDescription>
            Provisions a PersistentVolumeClaim in your{" "}
            <code>resource-vm-…</code> namespace. Attach to a VM at create
            time.
          </DialogDescription>
        </DialogHeader>

        <form
          id="new-volume-form"
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
          <div className="space-y-1.5">
            <Label htmlFor="vol-name">Name</Label>
            <Input
              id="vol-name"
              name="name"
              required
              maxLength={200}
              placeholder="My data volume"
            />
            <p className="text-muted-foreground text-xs">
              Just a label. The PVC name is auto-generated.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="vol-size">Size</Label>
              <span className="font-mono text-sm tabular-nums">
                {size} GiB
                {size === SIZE.recommended && (
                  <span className="text-muted-foreground ml-2 text-xs font-sans">
                    recommended
                  </span>
                )}
              </span>
            </div>
            <input type="hidden" name="sizeGi" value={size} />
            <Slider
              id="vol-size"
              value={[size]}
              onValueChange={([v]) => setSize(v ?? SIZE.min)}
              min={SIZE.min}
              max={SIZE.max}
              step={SIZE.step}
            />
            <div className="text-muted-foreground flex justify-between text-xs">
              <span>{SIZE.min} GiB</span>
              <span>Recommended: {SIZE.recommended} GiB</span>
              <span>{SIZE.max} GiB</span>
            </div>
          </div>

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
          <Button form="new-volume-form" type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create Volume"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function DeleteVolumeButton({
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
          !confirm(
            `Delete volume "${label}" (${slug})? Storage is permanently destroyed.`,
          )
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
        title={disabled ? "Volume is bound to a VM. Delete the VM first." : undefined}
      >
        {pending ? "Deleting…" : "Delete"}
      </Button>
    </form>
  )
}
