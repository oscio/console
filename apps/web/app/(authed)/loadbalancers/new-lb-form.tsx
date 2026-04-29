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
import type { Vm } from "@/lib/api"

type Action = (formData: FormData) => Promise<{ error?: string } | void>

export function NewLoadBalancerForm({
  action,
  vms,
}: {
  action: Action
  vms: Vm[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [vmSlug, setVmSlug] = useState(vms[0]?.slug ?? "")
  const [persist, setPersist] = useState(false)

  const noVms = vms.length === 0

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setError(null)
      }}
    >
      <DialogTrigger asChild>
        <Button disabled={noVms} title={noVms ? "Create a VM first" : undefined}>
          Create Load Balancer
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Load Balancer</DialogTitle>
          <DialogDescription>
            Exposes a VM port at <code>&lt;slug&gt;.lb.&lt;domain&gt;</code>.
            Traffic flows through Traefik on port 443.
          </DialogDescription>
        </DialogHeader>

        <form
          id="new-lb-form"
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
          <div className="space-y-1.5">
            <Label htmlFor="lb-name">Name</Label>
            <Input
              id="lb-name"
              name="name"
              required
              maxLength={200}
              placeholder="My exposed service"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="lb-vm">Target VM</Label>
            <input type="hidden" name="vmSlug" value={vmSlug} />
            <Select value={vmSlug} onValueChange={setVmSlug}>
              <SelectTrigger id="lb-vm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {vms.map((vm) => (
                  <SelectItem key={vm.slug} value={vm.slug}>
                    {vm.name} · {vm.slug}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="lb-port">Target port</Label>
            <Input
              id="lb-port"
              name="port"
              type="number"
              min={1}
              max={65535}
              required
              defaultValue={3000}
              placeholder="3000"
            />
            <p className="text-muted-foreground text-xs">
              The port your service listens on inside the VM. Common: 3000,
              5000, 8000, 8888.
            </p>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="persistOnVmDelete"
              value="true"
              checked={persist}
              onChange={(e) => setPersist(e.target.checked)}
              className="mt-1"
            />
            <span>
              Persist on VM delete
              <span className="text-muted-foreground ml-2 text-xs">
                Default: cascade-delete with target VM. Persisted LBs stay
                here even after the VM is gone.
              </span>
            </span>
          </label>

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
          <Button form="new-lb-form" type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function DeleteLoadBalancerButton({
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
        if (!confirm(`Delete Load Balancer "${label}" (${slug})?`)) return
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
