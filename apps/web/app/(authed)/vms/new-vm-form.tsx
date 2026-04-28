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
import { Slider } from "@workspace/ui/components/slider"
import { VM_DEFAULTS } from "@/lib/api"

type Action = (formData: FormData) => Promise<{ error?: string } | void>

// Slider configs. CPU in cores (0.5 step), memory + storage in GiB.
// Recommended values match VM_DEFAULTS — surfaced as a hint and used
// as the slider's initial position.
const CPU = { min: 0.5, max: 8, step: 0.5, recommended: 2 }
const MEM = { min: 1, max: 16, step: 1, recommended: 4 }
const STORE = { min: 5, max: 100, step: 5, recommended: 20 }

export function NewVmForm({ action }: { action: Action }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  // shadcn Select / Slider don't bubble to the underlying form on
  // submit (Radix Listbox + custom Slider). Mirror values into hidden
  // inputs so server-action FormData picks them up.
  const [imageType, setImageType] = useState<"base" | "desktop">("base")
  const [cpu, setCpu] = useState(CPU.recommended)
  const [memory, setMemory] = useState(MEM.recommended)
  const [storage, setStorage] = useState(STORE.recommended)

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

          <SliderField
            id="vm-cpu"
            label="CPU"
            value={cpu}
            onChange={setCpu}
            min={CPU.min}
            max={CPU.max}
            step={CPU.step}
            recommended={CPU.recommended}
            unit="cores"
            hiddenName="cpuRequest"
            hiddenValue={String(cpu)}
          />

          <SliderField
            id="vm-mem"
            label="Memory"
            value={memory}
            onChange={setMemory}
            min={MEM.min}
            max={MEM.max}
            step={MEM.step}
            recommended={MEM.recommended}
            unit="GiB"
            hiddenName="memoryRequest"
            hiddenValue={`${memory}Gi`}
          />

          <SliderField
            id="vm-storage"
            label="Storage"
            value={storage}
            onChange={setStorage}
            min={STORE.min}
            max={STORE.max}
            step={STORE.step}
            recommended={STORE.recommended}
            unit="GiB"
            hiddenName="storageSize"
            hiddenValue={`${storage}Gi`}
            hint="PersistentVolumeClaim size for /home/agent."
          />

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

void VM_DEFAULTS // imported for parity with the api; sliders source defaults from `*.recommended`.

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

function SliderField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  step,
  recommended,
  unit,
  hiddenName,
  hiddenValue,
  hint,
}: {
  id: string
  label: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step: number
  recommended: number
  unit: string
  hiddenName: string
  hiddenValue: string
  hint?: string
}) {
  const isRecommended = value === recommended
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        <span className="text-sm font-mono tabular-nums">
          {value} {unit}
          {isRecommended && (
            <span className="text-muted-foreground ml-2 text-xs font-sans">
              recommended
            </span>
          )}
        </span>
      </div>
      <input type="hidden" name={hiddenName} value={hiddenValue} />
      <Slider
        id={id}
        value={[value]}
        onValueChange={([v]) => onChange(v ?? min)}
        min={min}
        max={max}
        step={step}
      />
      <div className="text-muted-foreground flex justify-between text-xs">
        <span>{min} {unit}</span>
        <span>
          {hint ? `${hint} ` : ""}Recommended: {recommended} {unit}
        </span>
        <span>{max} {unit}</span>
      </div>
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
