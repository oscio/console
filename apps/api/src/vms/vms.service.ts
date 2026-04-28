import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { k8sApps, k8sCore } from "./k8s.client"
import {
  CreateVmInput,
  Vm,
  VM_AGENT_TYPE_LABEL,
  VM_IMAGE_TYPE_LABEL,
  VM_LABEL,
  VM_LABEL_VALUE,
  VM_OWNER_LABEL,
  VmAgentType,
  VmImageType,
  VmStatus,
} from "./vms.types"

// DNS-1123 label: lowercase, digits, hyphens; must start/end with alnum;
// max 63 chars. Used for namespace + StatefulSet name.
const DNS_1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
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

@Injectable()
export class VmsService {
  private readonly imageBase = process.env.VM_IMAGE_BASE ?? ""
  private readonly imageDesktop = process.env.VM_IMAGE_DESKTOP ?? ""
  private readonly vmDomain = process.env.VM_DOMAIN ?? "vm.localhost"

  imageFor(type: VmImageType): string {
    const ref = type === "desktop" ? this.imageDesktop : this.imageBase
    if (!ref) {
      throw new BadRequestException(
        `VM image for type=${type} is not configured (set VM_IMAGE_${type === "desktop" ? "DESKTOP" : "BASE"}).`,
      )
    }
    return ref
  }

  // List VMs across all `resource-vm-*` namespaces. We list StatefulSets
  // cluster-wide with the VM label, then derive the row shape — cheaper
  // and simpler than fanning out per namespace, and survives owners we
  // don't know about yet.
  async listAll(): Promise<Vm[]> {
    const apps = k8sApps()
    const res = await apps.listStatefulSetForAllNamespaces({
      labelSelector: `${VM_LABEL}=${VM_LABEL_VALUE}`,
    })
    return (res.items ?? []).map((sts) => this.toVm(sts))
  }

  async listForOwner(ownerId: string): Promise<Vm[]> {
    const apps = k8sApps()
    const ns = ownerNamespace(ownerId)
    const res = await apps.listNamespacedStatefulSet({
      namespace: ns,
      labelSelector: `${VM_LABEL}=${VM_LABEL_VALUE}`,
    }).catch((err: { code?: number; statusCode?: number }) => {
      if ((err.code ?? err.statusCode) === 404) return { items: [] }
      throw err
    })
    return (res.items ?? []).map((sts) => this.toVm(sts))
  }

  async create(ownerId: string, input: CreateVmInput): Promise<Vm> {
    const name = sanitizeLabel(input.name)
    if (!DNS_1123.test(name)) {
      throw new BadRequestException(
        "name must be a DNS-1123 label (lowercase alnum and hyphens).",
      )
    }
    const ns = ownerNamespace(ownerId)
    const image = this.imageFor(input.imageType)
    const storage = input.storageSize ?? "10Gi"

    await this.ensureNamespace(ns, ownerId)

    // Create the headless Service first so the StatefulSet's stable DNS
    // (`<name>-0.<svc>.<ns>.svc.cluster.local`) resolves the moment the
    // pod comes up.
    await this.ensureService(ns, name)

    const apps = k8sApps()
    try {
      await apps.createNamespacedStatefulSet({
        namespace: ns,
        body: {
          apiVersion: "apps/v1",
          kind: "StatefulSet",
          metadata: {
            name,
            namespace: ns,
            labels: this.vmLabels(ownerId, input.imageType, input.agentType),
          },
          spec: {
            serviceName: name,
            replicas: 1,
            selector: { matchLabels: { "agent-platform/vm-name": name } },
            template: {
              metadata: {
                labels: {
                  ...this.vmLabels(ownerId, input.imageType, input.agentType),
                  "agent-platform/vm-name": name,
                },
              },
              spec: {
                containers: [
                  {
                    name: "vm",
                    image,
                    ports: [{ name: "http", containerPort: 8080 }],
                    env: [
                      { name: "VM_OWNER", value: ownerId },
                      { name: "VM_NAME", value: name },
                      { name: "VM_AGENT", value: input.agentType },
                    ],
                    volumeMounts: [
                      { name: "data", mountPath: "/home/agent" },
                    ],
                  },
                ],
              },
            },
            volumeClaimTemplates: [
              {
                metadata: { name: "data" },
                spec: {
                  accessModes: ["ReadWriteOnce"],
                  resources: { requests: { storage } },
                },
              },
            ],
          },
        },
      })
    } catch (err: unknown) {
      const code = (err as { code?: number; statusCode?: number }).code
        ?? (err as { statusCode?: number }).statusCode
      if (code === 409) {
        throw new ConflictException(`VM "${name}" already exists in ${ns}.`)
      }
      throw err
    }

    const vms = await this.listForOwner(ownerId)
    const created = vms.find((v) => v.name === name)
    if (!created) throw new NotFoundException("VM created but not found.")
    return created
  }

  async delete(ownerId: string, name: string): Promise<void> {
    const slug = sanitizeLabel(name)
    if (!DNS_1123.test(slug)) {
      throw new BadRequestException("Invalid VM name.")
    }
    const ns = ownerNamespace(ownerId)
    const apps = k8sApps()
    const core = k8sCore()
    await apps
      .deleteNamespacedStatefulSet({ name: slug, namespace: ns })
      .catch((err: { code?: number; statusCode?: number }) => {
        if ((err.code ?? err.statusCode) === 404) return
        throw err
      })
    await core
      .deleteNamespacedService({ name: slug, namespace: ns })
      .catch(() => undefined)
    // PVCs created from volumeClaimTemplates aren't garbage-collected on
    // StatefulSet delete; remove them so storage isn't leaked.
    await core
      .deleteCollectionNamespacedPersistentVolumeClaim({
        namespace: ns,
        labelSelector: `agent-platform/vm-name=${slug}`,
      })
      .catch(() => undefined)
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
          labels: {
            [VM_LABEL]: "vm-namespace",
            [VM_OWNER_LABEL]: sanitizeLabel(ownerId),
          },
        },
      },
    })
  }

  private async ensureService(ns: string, name: string): Promise<void> {
    const core = k8sCore()
    try {
      await core.readNamespacedService({ name, namespace: ns })
      return
    } catch (err: unknown) {
      const code = (err as { code?: number; statusCode?: number }).code
        ?? (err as { statusCode?: number }).statusCode
      if (code !== 404) throw err
    }
    await core.createNamespacedService({
      namespace: ns,
      body: {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name, namespace: ns, labels: { [VM_LABEL]: VM_LABEL_VALUE } },
        spec: {
          clusterIP: "None",
          selector: { "agent-platform/vm-name": name },
          ports: [{ name: "http", port: 8080, targetPort: 8080 }],
        },
      },
    })
  }

  private vmLabels(
    ownerId: string,
    imageType: VmImageType,
    agentType: VmAgentType,
  ): Record<string, string> {
    return {
      [VM_LABEL]: VM_LABEL_VALUE,
      [VM_OWNER_LABEL]: sanitizeLabel(ownerId),
      [VM_IMAGE_TYPE_LABEL]: imageType,
      [VM_AGENT_TYPE_LABEL]: agentType,
    }
  }

  private toVm(sts: {
    metadata?: { name?: string; namespace?: string; labels?: Record<string, string>; uid?: string; creationTimestamp?: string | Date }
    status?: { readyReplicas?: number; replicas?: number }
  }): Vm {
    const name = sts.metadata?.name ?? "unknown"
    const namespace = sts.metadata?.namespace ?? "unknown"
    const labels = sts.metadata?.labels ?? {}
    const owner = labels[VM_OWNER_LABEL] ?? "unknown"
    const imageType = (labels[VM_IMAGE_TYPE_LABEL] as VmImageType) ?? "base"
    const agentType = (labels[VM_AGENT_TYPE_LABEL] as VmAgentType) ?? "none"
    const ready = sts.status?.readyReplicas ?? 0
    const replicas = sts.status?.replicas ?? 0
    let status: VmStatus = "Pending"
    if (ready > 0) status = "Running"
    else if (replicas > 0 && ready === 0) status = "Pending"
    else status = "Unknown"
    const ts = sts.metadata?.creationTimestamp
    const createdAt =
      ts instanceof Date ? ts.toISOString() : (ts ?? new Date().toISOString())
    return {
      id: sts.metadata?.uid ?? `${namespace}/${name}`,
      name,
      owner,
      namespace,
      imageType,
      agentType,
      status,
      hostname: `${name}.${this.vmDomain}`,
      createdAt,
    }
  }
}
