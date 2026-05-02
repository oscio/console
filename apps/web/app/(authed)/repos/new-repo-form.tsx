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
import { DeleteConfirmButton } from "@/components/delete-confirm-button"

type Action = (formData: FormData) => Promise<{ error?: string } | void>

export function NewRepoForm({ action }: { action: Action }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setError(null)
      }}
    >
      <DialogTrigger asChild>
        <Button>New Repo</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Repo</DialogTitle>
          <DialogDescription>
            Empty Forgejo repo at git.&lt;domain&gt;. Lowercase letters, digits
            and hyphens only — that's the slug used in the URL.
          </DialogDescription>
        </DialogHeader>

        <form
          id="new-repo-form"
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
            <Label htmlFor="repo-name">Name</Label>
            <Input
              id="repo-name"
              name="name"
              required
              maxLength={60}
              placeholder="my-project"
              pattern="[a-zA-Z0-9-]+"
            />
            <p className="text-muted-foreground text-xs">
              Used as the repo slug under git.&lt;domain&gt;/service/.
            </p>
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
          <Button form="new-repo-form" type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create Repo"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function DeleteRepoButton({
  action,
  slug,
}: {
  action: (formData: FormData) => Promise<void>
  slug: string
}) {
  return (
    <DeleteConfirmButton
      action={action}
      hiddenFields={{ slug }}
      title="Delete repo?"
      description={
        <>
          Delete repo <span className="font-mono">{slug}</span>? Forgejo
          content goes too. Irreversible.
        </>
      }
    />
  )
}
