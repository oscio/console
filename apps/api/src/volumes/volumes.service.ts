import { randomBytes } from "node:crypto"
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { authPool } from "@workspace/auth"
import { OpenFgaService } from "../openfga/openfga.service"
import { k8sCore } from "../vms/k8s.client"
import {
  CreateVolumeInput,
  Volume,
  VolumeStatus,
  VOLUME_BOUND_TO_LABEL,
  VOLUME_DISPLAY_NAME_ANNOTATION,
  VOLUME_LABEL,
  VOLUME_LABEL_VALUE,
  VOLUME_OWNER_LABEL,
} from "./volumes.types"

const NS_PREFIX = "resource-vm-"

function sanitizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
}

function ownerNamespace(ownerId: string): string {
  const slug = sanitizeLabel(ownerId)
  if (!slug) throw new BadRequestException("Invalid owner id")
  return `${NS_PREFIX}${slug}`
}

function randomSlug(): string {
  return `volume-${randomBytes(4).toString("hex")}`
}

function rethrowK8sError(err: unknown, fallback: string): never {
  const e = err as { code?: number; statusCode?: number; body?: unknown; message?: string }
  const code = e.code ?? e.statusCode
  if (typeof code === "number" && code >= 400 && code < 500) {
    let msg = fallback
    if (typeof e.body === "string") {
      try {
        const parsed = JSON.parse(e.body) as { message?: string }
        if (parsed.message) msg = parsed.message
      } catch {
        msg = e.body
      }
    }
    throw new HttpException(msg, code)
  }
  throw err
}

// PVC phase → simplified status. Treats "Available" as "no claim ever
// bound" — for the UI's "attach a free volume" affordance, that's
// what the user wants to see in the dropdown.
function statusFromPhase(
  phase: string | undefined,
  boundTo: string | null,
): VolumeStatus {
  if (phase === "Bound") return boundTo ? "Bound" : "Available"
  if (phase === "Pending") return "Pending"
  if (phase === "Lost" || phase === "Failed") return "Failed"
  return "Unknown"
}

@Injectable()
export class VolumesService {
  constructor(private readonly fga: OpenFgaService) {}

  // List every volume owned by a user. Free volumes (no boundTo
  // label) are what `Attach existing` in the VM create flow shows.
  async listForOwner(ownerId: string): Promise<Volume[]> {
    const core = k8sCore()
    const ns = ownerNamespace(ownerId)
    const res = await core.listNamespacedPersistentVolumeClaim({
      namespace: ns,
      labelSelector: `${VOLUME_LABEL}=${VOLUME_LABEL_VALUE}`,
    }).catch((err: { code?: number; statusCode?: number }) => {
      if ((err.code ?? err.statusCode) === 404) return { items: [] }
      throw err
    })
    return (res.items ?? []).map((p) => this.toVolume(p))
  }

  async create(ownerId: string, input: CreateVolumeInput): Promise<Volume> {
    const displayName = input.name.trim()
    if (!displayName) throw new BadRequestException("name is required")
    if (input.sizeGi < 1 || input.sizeGi > 200) {
      throw new BadRequestException("sizeGi must be between 1 and 200")
    }
    const slug = randomSlug()
    const ns = ownerNamespace(ownerId)

    await this.ensureNamespace(ns, ownerId)

    const core = k8sCore()
    try {
      await core.createNamespacedPersistentVolumeClaim({
        namespace: ns,
        body: {
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          metadata: {
            name: slug,
            namespace: ns,
            labels: {
              [VOLUME_LABEL]: VOLUME_LABEL_VALUE,
              [VOLUME_OWNER_LABEL]: sanitizeLabel(ownerId),
            },
            annotations: { [VOLUME_DISPLAY_NAME_ANNOTATION]: displayName },
          },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: {
              requests: { storage: `${input.sizeGi}Gi` },
            },
          },
        },
      })
    } catch (err: unknown) {
      const code = (err as { code?: number; statusCode?: number }).code
        ?? (err as { statusCode?: number }).statusCode
      if (code === 409) {
        throw new ConflictException(`Volume "${slug}" already exists in ${ns}.`)
      }
      rethrowK8sError(err, `Failed to create volume "${slug}"`)
    }

    await this.fga.grantVolumeOwner(slug, ownerId).catch((err) => {
      throw new Error(
        `Volume ${slug} created but FGA tuple write failed: ${(err as Error).message}`,
      )
    })

    const list = await this.listForOwner(ownerId)
    const created = list.find((v) => v.slug === slug)
    if (!created) throw new NotFoundException("Volume created but not found.")
    return created
  }

  async delete(ownerId: string, slug: string): Promise<void> {
    const cleanSlug = sanitizeLabel(slug)
    if (!cleanSlug) throw new BadRequestException("Invalid volume slug.")
    const ns = ownerNamespace(ownerId)
    const core = k8sCore()
    // Refuse to delete a bound volume — the user should detach (delete
    // the VM) first. K8s would queue the PVC for deletion otherwise,
    // which surprises users.
    const list = await this.listForOwner(ownerId)
    const v = list.find((x) => x.slug === cleanSlug)
    if (v?.boundTo) {
      throw new ConflictException(
        `Volume "${cleanSlug}" is bound to VM "${v.boundTo}". Delete the VM first.`,
      )
    }
    await core
      .deleteNamespacedPersistentVolumeClaim({ name: cleanSlug, namespace: ns })
      .catch((err: { code?: number; statusCode?: number }) => {
        if ((err.code ?? err.statusCode) === 404) return
        throw err
      })
    const owners = await this.fga.listVolumeOwners(cleanSlug).catch(() => [])
    for (const u of owners) {
      await this.fga.revokeVolumeOwner(cleanSlug, u).catch(() => undefined)
    }
  }

  // Mark a volume as bound to a VM (sets the bound-to label). Called
  // by the VMs service during create when a volume is attached.
  async bindToVm(ownerId: string, volumeSlug: string, vmSlug: string): Promise<void> {
    const ns = ownerNamespace(ownerId)
    const core = k8sCore()
    await core
      .patchNamespacedPersistentVolumeClaim({
        name: volumeSlug,
        namespace: ns,
        body: {
          metadata: { labels: { [VOLUME_BOUND_TO_LABEL]: vmSlug } },
        },
      })
      .catch((err) => rethrowK8sError(err, `Failed to bind volume "${volumeSlug}"`))
  }

  // Inverse of bindToVm — clears the bound-to label so the volume
  // shows up in the "attach" picker again.
  async unbindFromVm(ownerId: string, volumeSlug: string): Promise<void> {
    const ns = ownerNamespace(ownerId)
    const core = k8sCore()
    await core
      .patchNamespacedPersistentVolumeClaim({
        name: volumeSlug,
        namespace: ns,
        body: {
          metadata: { labels: { [VOLUME_BOUND_TO_LABEL]: null } },
        },
      })
      .catch(() => undefined)
  }

  async canAccessByEmail(email: string, slug: string): Promise<boolean> {
    const cleanSlug = sanitizeLabel(slug)
    if (!cleanSlug || !email) return false
    const { rows } = await authPool.query<{ id: string }>(
      `SELECT id FROM "user" WHERE lower(email) = lower($1) LIMIT 1`,
      [email],
    )
    const userId = rows[0]?.id
    if (!userId) return false
    return this.fga.canAccessVolume(userId, cleanSlug)
  }

  private async ensureNamespace(ns: string, ownerId: string): Promise<void> {
    const core = k8sCore()
    try {
      await core.readNamespace({ name: ns })
      return
    } catch (err: unknown) {
      const code = (err as { code?: number; statusCode?: number }).code
        ?? (err as { statusCode?: number }).statusCode
      if (code !== 404) throw err
    }
    await core.createNamespace({
      body: {
        metadata: {
          name: ns,
          labels: { [VOLUME_OWNER_LABEL]: sanitizeLabel(ownerId) },
        },
      },
    })
  }

  private toVolume(pvc: {
    metadata?: {
      name?: string
      namespace?: string
      labels?: Record<string, string>
      annotations?: Record<string, string>
      uid?: string
      creationTimestamp?: string | Date
    }
    spec?: { resources?: { requests?: { storage?: string } } }
    status?: { phase?: string }
  }): Volume {
    const slug = pvc.metadata?.name ?? "unknown"
    const namespace = pvc.metadata?.namespace ?? "unknown"
    const labels = pvc.metadata?.labels ?? {}
    const annotations = pvc.metadata?.annotations ?? {}
    const displayName = annotations[VOLUME_DISPLAY_NAME_ANNOTATION] ?? slug
    const owner = labels[VOLUME_OWNER_LABEL] ?? "unknown"
    const boundTo = labels[VOLUME_BOUND_TO_LABEL] ?? null
    const status = statusFromPhase(pvc.status?.phase, boundTo)
    const ts = pvc.metadata?.creationTimestamp
    const createdAt =
      ts instanceof Date ? ts.toISOString() : (ts ?? new Date().toISOString())
    const sizeStr = pvc.spec?.resources?.requests?.storage ?? "1Gi"
    const sizeGi = parseGi(sizeStr)
    return {
      id: pvc.metadata?.uid ?? `${namespace}/${slug}`,
      slug,
      name: displayName,
      owner,
      namespace,
      status,
      sizeGi,
      boundTo,
      createdAt,
    }
  }
}

function parseGi(qty: string): number {
  // Accept "20Gi", "20Gi", "1.5Gi". Rounded to one decimal for UI.
  const m = /^([0-9.]+)Gi$/.exec(qty)
  return m ? Math.round(Number(m[1]) * 10) / 10 : 0
}
