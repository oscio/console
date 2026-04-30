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
import type { Volume } from "@/lib/api"
import { type AgentModel, DEFAULT_AGENT_MODEL } from "@/lib/agent-models"

type Action = (formData: FormData) => Promise<{ error?: string } | void>

const CPU = { min: 0.5, max: 8, step: 0.5, recommended: 2 }
const MEM = { min: 1, max: 16, step: 1, recommended: 4 }
const VOL = { min: 1, max: 20, step: 1, recommended: 2 }

type Mode = "new" | "attach" | "none"

export function NewVmForm({
  action,
  freeVolumes,
  models,
}: {
  action: Action
  // Volumes the current user owns that aren't bound to any VM —
  // shown in the "Attach existing" dropdown.
  freeVolumes: Volume[]
  // OpenRouter model catalog for the attached-agent dropdown.
  models: AgentModel[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [imageType, setImageType] = useState<"base" | "desktop">("base")
  const [cpu, setCpu] = useState(CPU.recommended)
  const [memory, setMemory] = useState(MEM.recommended)

  const [volumeMode, setVolumeMode] = useState<Mode>("new")
  const [volumeSize, setVolumeSize] = useState(VOL.recommended)
  const [persist, setPersist] = useState(false)
  const [attachSlug, setAttachSlug] = useState<string>(freeVolumes[0]?.slug ?? "")

  // Agent attachment. "none" = no sidecar; otherwise the chosen value
  // becomes AGENT_TYPE on the agent sidecar container, which the
  // FastAPI wrapper inside dispatches on. Attached agents surface
  // under /agents (boundToVm = this VM's slug).
  const [agentType, setAgentType] = useState<"none" | "hermes" | "zeroclaw">(
    "none",
  )
  const initialAgentModel =
    models.find((m) => m.id === DEFAULT_AGENT_MODEL)?.id ??
    models[0]?.id ??
    DEFAULT_AGENT_MODEL
  const [agentModel, setAgentModel] = useState<string>(initialAgentModel)

  // Cluster-admin opt-in. Off by default; the api always grants
  // namespace-admin in `resource` ns so kubectl works for own-VM
  // operations regardless. cluster-admin is the extra-broad grant
  // for terraform-apply / cross-namespace work.
  const [clusterAdmin, setClusterAdmin] = useState(false)

  // Multiple LBs per VM. Each item becomes one ClusterIP Service +
  // HTTPRoute pair on the api side. `key` is React-only — stripped
  // before encoding into the hidden `loadBalancers` field.
  type LbDraft = {
    key: string
    name: string
    port: number
  }
  const [lbs, setLbs] = useState<LbDraft[]>([])
  const addLb = () =>
    setLbs((prev) => [
      ...prev,
      {
        key:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random()}`,
        name: "",
        port: 3000,
      },
    ])
  const removeLb = (key: string) =>
    setLbs((prev) => prev.filter((l) => l.key !== key))
  const updateLb = (key: string, patch: Partial<LbDraft>) =>
    setLbs((prev) =>
      prev.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    )
  const lbsPayload = JSON.stringify(
    lbs.map(({ name, port }) => ({
      name: name.trim() || undefined,
      port,
    })),
  )

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
          className="space-y-5 max-h-[70vh] overflow-y-auto overflow-x-hidden px-1"
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

          {/* Volume mode + sub-fields */}
          <div className="space-y-3">
            <Label htmlFor="vm-volume-mode">Volume</Label>
            <input type="hidden" name="volumeMode" value={volumeMode} />
            <Select
              value={volumeMode}
              onValueChange={(v) => setVolumeMode(v as Mode)}
            >
              <SelectTrigger id="vm-volume-mode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new">Create new</SelectItem>
                <SelectItem value="attach" disabled={freeVolumes.length === 0}>
                  Attach existing
                  {freeVolumes.length === 0 ? " (none free)" : ""}
                </SelectItem>
                <SelectItem value="none">No volume (ephemeral)</SelectItem>
              </SelectContent>
            </Select>

            {volumeMode === "new" && (
              <div className="space-y-3 ">
                <SliderField
                  id="vm-volume-size"
                  label="Size"
                  value={volumeSize}
                  onChange={setVolumeSize}
                  min={VOL.min}
                  max={VOL.max}
                  step={VOL.step}
                  recommended={VOL.recommended}
                  unit="GiB"
                  hiddenName="volumeSizeGi"
                  hiddenValue={String(volumeSize)}
                />
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="persistVolumeOnDelete"
                    value="true"
                    checked={persist}
                    onChange={(e) => setPersist(e.target.checked)}
                    className="mt-1"
                  />
                  <span>
                    Persist on VM delete
                    <span className="text-muted-foreground ml-2 text-xs">
                      Default: delete with VM. Persisted volumes show up
                      under <code>/volumes</code> for re-attach.
                    </span>
                  </span>
                </label>
              </div>
            )}

            {volumeMode === "attach" && (
              <div className="space-y-1.5 ">
                <Label htmlFor="vm-volume-slug" className="text-xs">
                  Free volume
                </Label>
                <input type="hidden" name="volumeSlug" value={attachSlug} />
                <Select value={attachSlug} onValueChange={setAttachSlug}>
                  <SelectTrigger id="vm-volume-slug" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {freeVolumes.map((v) => (
                      <SelectItem key={v.slug} value={v.slug}>
                        {v.name} ({v.sizeGi} GiB) · {v.slug}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {volumeMode === "none" && (
              <p className="text-muted-foreground text-xs ">
                The pod's <code>/home/agent</code> lives on the container's
                ephemeral filesystem; everything is lost on pod restart.
              </p>
            )}
          </div>

          {/* Agent attachment. "none" = no sidecar. Otherwise an
              agent sidecar runs in this pod and surfaces in /agents
              with boundToVm = <this VM>. Bash inside the sidecar is
              shimmed over SSH to this workspace, so the agent's
              tool calls operate on the user's actual environment. */}
          <div className="space-y-3">
            <Label htmlFor="vm-agent-type">Agent</Label>
            <input type="hidden" name="agentType" value={agentType} />
            <Select
              value={agentType}
              onValueChange={(v) =>
                setAgentType(v as "none" | "hermes" | "zeroclaw")
              }
            >
              <SelectTrigger id="vm-agent-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No agent</SelectItem>
                <SelectItem value="zeroclaw">zeroclaw</SelectItem>
                <SelectItem value="hermes">hermes</SelectItem>
              </SelectContent>
            </Select>
            {agentType !== "none" && (
              <>
                <p className="text-muted-foreground text-xs">
                  The agent appears under <code>/agents</code> with{" "}
                  <code>boundToVm = &lt;this VM&gt;</code>. Cascade-deleted
                  with the VM.
                </p>
                {agentType === "zeroclaw" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="vm-agent-model" className="text-xs">
                      Model
                    </Label>
                    <input
                      type="hidden"
                      name="agentModel"
                      value={agentModel}
                    />
                    <Select value={agentModel} onValueChange={setAgentModel}>
                      <SelectTrigger
                        id="vm-agent-model"
                        className="w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {models.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-muted-foreground text-xs">
                      Routed via OpenRouter. Provider key is platform-wide
                      (set in <code>/settings</code>).
                    </p>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Per-VM ServiceAccount + namespace-admin RoleBinding are
              always created (so kubectl works out of the box for own-VM
              operations). Cluster-admin is opt-in for terraform-apply /
              cross-namespace work. */}
          <div className="space-y-1.5">
            <Label>kubectl access</Label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="clusterAdmin"
                value="true"
                checked={clusterAdmin}
                onChange={(e) => setClusterAdmin(e.target.checked)}
                className="mt-1"
              />
              <span>
                Grant cluster-admin
                <span className="text-muted-foreground ml-2 text-xs">
                  Default: namespace-admin in <code>resource</code>.
                  Tick to also bind cluster-admin (full cluster access
                  for <code>terraform apply</code> / cross-namespace).
                </span>
              </span>
            </label>
          </div>

          {/* Load Balancers (optional, default empty). Each row becomes
              an LB at <slug>.lb.<domain> targeting <port>. Persist
              controls cleanup on VM delete (default: cascade-delete). */}
          <div className="space-y-3">
            <div className="flex items-baseline justify-between gap-2">
              <Label>Load Balancers</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={addLb}
              >
                Add load balancer
              </Button>
            </div>
            <input type="hidden" name="loadBalancers" value={lbsPayload} />

            {lbs.length === 0 && (
              <p className="text-muted-foreground text-xs">
                None. Each LB gets its own{" "}
                <code>&lt;slug&gt;.lb.&lt;domain&gt;</code> hostname pointing
                at the VM port you choose.
              </p>
            )}

            {lbs.map((lb, idx) => (
              <div
                key={lb.key}
                className="space-y-3 border p-3"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-muted-foreground text-xs font-mono">
                    LB #{idx + 1}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => removeLb(lb.key)}
                    className="text-destructive hover:text-destructive"
                  >
                    Remove
                  </Button>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`vm-lb-${lb.key}-name`} className="text-xs">
                    Name <span className="text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    id={`vm-lb-${lb.key}-name`}
                    value={lb.name}
                    onChange={(e) => updateLb(lb.key, { name: e.target.value })}
                    placeholder="auto: <vm-name> :<port>"
                    maxLength={200}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`vm-lb-${lb.key}-port`} className="text-xs">
                    Target port
                  </Label>
                  <Input
                    id={`vm-lb-${lb.key}-port`}
                    type="number"
                    min={1}
                    max={65535}
                    value={lb.port}
                    onChange={(e) =>
                      updateLb(lb.key, { port: Number(e.target.value) || 0 })
                    }
                  />
                </div>
              </div>
            ))}
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
          <Button form="new-vm-form" type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create VM"}
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
      {/* The Radix Slider thumb is centered on its value's % — at
          min/max it half-overflows the track. Inset the thumb track
          by half its width so it stays within the dialog. */}
      <div className="px-2.5">
        <Slider
          id={id}
          value={[value]}
          onValueChange={([v]) => onChange(v ?? min)}
          min={min}
          max={max}
          step={step}
        />
      </div>
      <div className="text-muted-foreground flex justify-between text-xs">
        <span>{min} {unit}</span>
        <span>Recommended: {recommended} {unit}</span>
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
