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
import { DeleteConfirmButton } from "@/components/delete-confirm-button"
import type { Repo } from "@/lib/api"

type Action = (formData: FormData) => Promise<{ error?: string } | void>
type Mode = null | "empty" | "fork" | "import"

export function NewRepoMenu({
  createAction,
  forkAction,
  importAction,
  sources,
}: {
  createAction: Action
  forkAction: Action
  importAction: Action
  sources: Repo[]
}) {
  const [mode, setMode] = useState<Mode>(null)
  return (
    <>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={() => setMode("import")}>
          Import GitHub
        </Button>
        <Button
          variant="outline"
          onClick={() => setMode("fork")}
          disabled={sources.length === 0}
        >
          Fork Forgejo
        </Button>
        <Button onClick={() => setMode("empty")}>+ New Repo</Button>
      </div>

      {mode === "empty" && (
        <EmptyDialog
          action={createAction}
          onClose={() => setMode(null)}
        />
      )}
      {mode === "fork" && (
        <ForkDialog
          action={forkAction}
          sources={sources}
          onClose={() => setMode(null)}
        />
      )}
      {mode === "import" && (
        <ImportDialog
          action={importAction}
          onClose={() => setMode(null)}
        />
      )}
    </>
  )
}

function EmptyDialog({
  action,
  onClose,
}: {
  action: Action
  onClose: () => void
}) {
  return (
    <ModeDialog
      title="New empty repo"
      description="Empty Forgejo repo at git.<domain>/service/. Lowercase letters, digits and hyphens only."
      formId="repo-empty"
      submitLabel="Create"
      action={action}
      onClose={onClose}
    >
      <Field id="repo-name" label="Name" hint="Used as the repo slug.">
        <Input
          id="repo-name"
          name="name"
          required
          maxLength={60}
          placeholder="my-project"
          pattern="[a-zA-Z0-9-]+"
        />
      </Field>
    </ModeDialog>
  )
}

function ForkDialog({
  action,
  sources,
  onClose,
}: {
  action: Action
  sources: Repo[]
  onClose: () => void
}) {
  const [pick, setPick] = useState<string>(
    sources.length > 0 ? `${sources[0]!.forgejoOrg}/${sources[0]!.slug}` : "",
  )
  return (
    <ModeDialog
      title="Fork from Forgejo"
      description="Pick a Forgejo repo to one-time copy into your namespace. The upstream link drops after the fork."
      formId="repo-fork"
      submitLabel="Fork"
      action={action}
      onClose={onClose}
    >
      <Field id="repo-source" label="Source repo">
        <input type="hidden" name="source" value={pick} />
        <Select value={pick} onValueChange={setPick}>
          <SelectTrigger id="repo-source" className="w-full">
            <SelectValue placeholder="Choose a repo" />
          </SelectTrigger>
          <SelectContent>
            {sources.map((s) => (
              <SelectItem
                key={`${s.forgejoOrg}/${s.slug}`}
                value={`${s.forgejoOrg}/${s.slug}`}
              >
                {s.forgejoOrg}/{s.slug}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field
        id="repo-fork-name"
        label="Target name"
        hint="Defaults to the source name. Sanitised to a slug."
      >
        <Input
          id="repo-fork-name"
          name="name"
          maxLength={60}
          placeholder="my-fork"
          pattern="[a-zA-Z0-9-]*"
        />
      </Field>
    </ModeDialog>
  )
}

function ImportDialog({
  action,
  onClose,
}: {
  action: Action
  onClose: () => void
}) {
  return (
    <ModeDialog
      title="Import from GitHub"
      description="One-time copy of a public GitHub repo into Forgejo. After this it's a normal Forgejo repo with no GitHub link."
      formId="repo-import"
      submitLabel="Import"
      action={action}
      onClose={onClose}
    >
      <Field
        id="repo-github-url"
        label="GitHub URL"
        hint="Public repo only. Format: https://github.com/<owner>/<name>"
      >
        <Input
          id="repo-github-url"
          name="githubUrl"
          required
          type="url"
          placeholder="https://github.com/torvalds/linux"
        />
      </Field>
      <Field
        id="repo-import-name"
        label="Target name"
        hint="Defaults to the GitHub repo name. Sanitised to a slug."
      >
        <Input
          id="repo-import-name"
          name="name"
          maxLength={60}
          pattern="[a-zA-Z0-9-]*"
        />
      </Field>
    </ModeDialog>
  )
}

function ModeDialog({
  title,
  description,
  formId,
  submitLabel,
  action,
  onClose,
  children,
}: {
  title: string
  description: string
  formId: string
  submitLabel: string
  action: Action
  onClose: () => void
  children: React.ReactNode
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) {
          setError(null)
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form
          id={formId}
          className="space-y-4"
          action={(fd) =>
            startTransition(async () => {
              setError(null)
              const result = await action(fd)
              if (result?.error) {
                setError(result.error)
                return
              }
              onClose()
              router.refresh()
            })
          }
        >
          {children}
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
          <Button form={formId} type="submit" disabled={pending}>
            {pending ? "Working…" : submitLabel}
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

