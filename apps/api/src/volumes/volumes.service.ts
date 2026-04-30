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
import { k8sApps, k8sCore, k8sCustom } from "../vms/k8s.client"
import { RESOURCE_NS } from "../vms/vms.service"
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

function sanitizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
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
//
// `phase=Pending + boundTo=null` is also reported as "Available": the
// k3s default StorageClass uses WaitForFirstConsumer, so a fresh
// standalone PVC sits Pending forever until something mounts it.
// From the user's view it IS available for attach, so we map it
// that way instead of leaving it in a misleading Pending state.
// Genuine provisioning failures still surface as Failed (Lost/Failed
// phase) because those phases never set Pending.
function statusFromPhase(
  phase: string | undefined,
  boundTo: string | null,
): VolumeStatus {
  if (phase === "Bound") return boundTo ? "Bound" : "Available"
  if (phase === "Pending") return boundTo ? "Pending" : "Available"
  if (phase === "Lost" || phase === "Failed") return "Failed"
  return "Unknown"
}

@Injectable()
export class VolumesService {
  constructor(private readonly fga: OpenFgaService) {}

  // FGA-driven: ask FGA which volumes the user can access, batch-read
  // those PVCs from the unified namespace. Stale tuples (FGA yes,
  // k8s 404) are silently dropped.
  async listForOwner(ownerId: string): Promise<Volume[]> {
    const slugs = await this.fga.listAccessibleVolumes(ownerId)
    if (slugs.length === 0) return []
    const core = k8sCore()
    const apps = k8sApps()
    // Pull the live VM set in parallel with PVC reads so we can
    // detect stale boundTo labels (label set, but the VM no longer
    // exists). One extra cluster-wide list call per /volumes refresh.
    const [results, vmRes] = await Promise.all([
      Promise.all(
        slugs.map((slug) =>
          core
            .readNamespacedPersistentVolumeClaim({
              name: slug,
              namespace: RESOURCE_NS,
            })
            .catch(() => null),
        ),
      ),
      apps
        .listNamespacedStatefulSet({ namespace: RESOURCE_NS })
        .catch(() => ({ items: [] })),
    ])
    const liveVms = new Set(
      (vmRes.items ?? [])
        .map((s) => s.metadata?.name)
        .filter((n): n is string => !!n),
    )
    return results
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .map((p) => {
        const v = this.toVolume(p)
        if (v.boundTo && !liveVms.has(v.boundTo)) {
          // Self-heal: drop the stale label so future reads (and
          // the "attach existing" picker) treat the volume as free.
          // Fire-and-forget — list call stays read-shaped from the
          // caller's perspective.
          void this.unbindFromVm(ownerId, v.slug).catch(() => undefined)
          v.boundTo = null
          v.status = v.status === "Bound" ? "Available" : v.status
        }
        return v
      })
  }

  async create(ownerId: string, input: CreateVolumeInput): Promise<Volume> {
    const displayName = input.name.trim()
    if (!displayName) throw new BadRequestException("name is required")
    if (input.sizeGi < 1 || input.sizeGi > 200) {
      throw new BadRequestException("sizeGi must be between 1 and 200")
    }
    const slug = randomSlug()
    const ns = RESOURCE_NS

    await this.ensureNamespace(ns)

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
    // FGA gate. 404 (not 403) so we don't leak existence to non-owners.
    const allowed = await this.fga.canAccessVolume(ownerId, cleanSlug)
    if (!allowed) {
      throw new NotFoundException(`Volume "${cleanSlug}" not found.`)
    }
    const ns = RESOURCE_NS
    const core = k8sCore()
    // Refuse to delete a bound volume — the user should detach (delete
    // the VM) first. K8s would queue the PVC for deletion otherwise,
    // which surprises users.
    //
    // Exception: if the boundTo VM is "abandoned" (no FGA owners —
    // i.e. left over from a partial create where grantVmOwner never
    // ran), self-heal: unbind the volume and clean up the orphaned
    // VM resources directly. The volume's owner is the only legitimate
    // stakeholder at that point.
    const list = await this.listForOwner(ownerId)
    const v = list.find((x) => x.slug === cleanSlug)
    if (v?.boundTo) {
      const orphan = await this.isAbandonedVm(v.boundTo)
      if (!orphan) {
        throw new ConflictException(
          `Volume "${cleanSlug}" is bound to VM "${v.boundTo}". Delete the VM first.`,
        )
      }
      await this.unbindFromVm(ownerId, cleanSlug).catch(() => undefined)
      await this.cleanupAbandonedVm(v.boundTo)
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

  // The k8s-client v1.x defaults patch Content-Type to JSON Patch
  // (RFC 6902, an array of `{op, path, value}`). The `body` arg is
  // typed as `object`, but Kubernetes' API server rejects anything
  // that doesn't decode as `[]jsonPatchOp`. Easiest path: send a
  // proper JSON Patch array. Forward-slash in label keys is
  // encoded as `~1` per JSON Pointer (RFC 6901).
  async bindToVm(ownerId: string, volumeSlug: string, vmSlug: string): Promise<void> {
    // ownerId arg kept for symmetry — namespace is now unified, so it
    // isn't used to locate the PVC. Caller's ownership has already
    // been validated upstream (vms.service before bind).
    void ownerId
    const ns = RESOURCE_NS
    const core = k8sCore()
    const path = jsonPointerLabel(VOLUME_BOUND_TO_LABEL)
    await core
      .patchNamespacedPersistentVolumeClaim({
        name: volumeSlug,
        namespace: ns,
        // `add` semantics: create if absent, replace if present.
        body: [{ op: "add", path: `/metadata/labels${path}`, value: vmSlug }] as unknown as object,
      })
      .catch((err) => rethrowK8sError(err, `Failed to bind volume "${volumeSlug}"`))
  }

  // Inverse of bindToVm — clears the bound-to label so the volume
  // shows up in the "attach" picker again. `remove` 422s when the
  // label is already missing; that's fine, just swallow it.
  async unbindFromVm(ownerId: string, volumeSlug: string): Promise<void> {
    void ownerId
    const ns = RESOURCE_NS
    const core = k8sCore()
    const path = jsonPointerLabel(VOLUME_BOUND_TO_LABEL)
    await core
      .patchNamespacedPersistentVolumeClaim({
        name: volumeSlug,
        namespace: ns,
        body: [{ op: "remove", path: `/metadata/labels${path}` }] as unknown as object,
      })
      .catch(() => undefined)
  }

  // True when the named VM has no FGA owner tuples — i.e. nobody
  // claims it. Either the VM never finished its create (grantVmOwner
  // never ran) or the tuple was cleaned out manually. Volume delete
  // uses this to decide whether to self-heal.
  private async isAbandonedVm(vmSlug: string): Promise<boolean> {
    const owners = await this.fga.listVmOwners(vmSlug).catch(() => null)
    if (owners === null) return false
    return owners.length === 0
  }

  // Best-effort cleanup of an abandoned VM's k8s resources. Mirrors
  // VmsService.delete's k8s teardown but skips the FGA / volume /
  // LB cascade (no owner means no LBs were ever granted; the volume
  // is the caller's, already being unbound by the caller).
  private async cleanupAbandonedVm(vmSlug: string): Promise<void> {
    const apps = k8sApps()
    const core = k8sCore()
    const custom = k8sCustom()
    await apps
      .deleteNamespacedStatefulSet({ name: vmSlug, namespace: RESOURCE_NS })
      .catch(() => undefined)
    await core
      .deleteNamespacedService({ name: vmSlug, namespace: RESOURCE_NS })
      .catch(() => undefined)
    for (const svc of ["term", "code", "vnc"]) {
      await custom
        .deleteNamespacedCustomObject({
          group: "gateway.networking.k8s.io",
          version: "v1",
          namespace: RESOURCE_NS,
          plural: "httproutes",
          name: `${vmSlug}-${svc}`,
        })
        .catch(() => undefined)
    }
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

  private async ensureNamespace(ns: string): Promise<void> {
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
      body: { metadata: { name: ns } },
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

// JSON Pointer encoding for label keys. Slash → ~1, tilde → ~0.
// e.g. `agent-platform/volume-bound-to` → `/agent-platform~1volume-bound-to`.
function jsonPointerLabel(label: string): string {
  return `/${label.replace(/~/g, "~0").replace(/\//g, "~1")}`
}
