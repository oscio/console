import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { randomBytes } from "node:crypto"
import { k8sApps, k8sCore, k8sCustom } from "./k8s.client"
import {
  CreateVmInput,
  Vm,
  VM_AGENT_TYPE_LABEL,
  VM_DISPLAY_NAME_ANNOTATION,
  VM_IMAGE_TYPE_LABEL,
  VM_LABEL,
  VM_LABEL_VALUE,
  VM_OWNER_LABEL,
  VmAgentType,
  VmImageType,
  VmStatus,
} from "./vms.types"

const NS_PREFIX = "resource-vm-"

function sanitizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
}

// Random slug used as the K8s resource name + hostname. Always
// DNS-1035-valid: starts with a letter, lowercase alnum, length 11.
function randomSlug(): string {
  return `vm-${randomBytes(4).toString("hex")}`
}

function ownerNamespace(ownerId: string): string {
  const slug = sanitizeLabel(ownerId)
  if (!slug) throw new BadRequestException("Invalid owner id")
  return `${NS_PREFIX}${slug}`
}

// @kubernetes/client-node throws ApiException with the K8s 4xx body
// stringified inside. NestJS' default exception filter turns anything
// non-HttpException into 500, hiding the actual reason. Surface the
// K8s message and status (400, 404, 409, 422) so the UI can show it.
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

@Injectable()
export class VmsService {
  private readonly imageBase = process.env.VM_IMAGE_BASE ?? ""
  private readonly imageDesktop = process.env.VM_IMAGE_DESKTOP ?? ""
  private readonly vmDomain = process.env.VM_DOMAIN ?? "vm.localhost"
  // Console hostname carries every VM's launch URLs as `/vms/<slug>/...`
  // so they reuse the existing trusted cert (no per-host CA-trust dance).
  private readonly consoleHostname =
    process.env.CONSOLE_HOSTNAME ?? "console.localhost"
  // Gateway API parent ref for per-VM HTTPRoutes. Defaults match the
  // dev cluster's `platform-gateway` in `platform-traefik`.
  private readonly gatewayName =
    process.env.VM_GATEWAY_NAME ?? "platform-gateway"
  private readonly gatewayNamespace =
    process.env.VM_GATEWAY_NAMESPACE ?? "platform-traefik"

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
    const displayName = input.name.trim()
    if (!displayName) throw new BadRequestException("name is required")
    if (displayName.length > 200) {
      throw new BadRequestException("name must be 200 characters or fewer")
    }
    const slug = randomSlug()
    const ns = ownerNamespace(ownerId)
    const image = this.imageFor(input.imageType)
    const storage = input.storageSize ?? "10Gi"

    await this.ensureNamespace(ns, ownerId)

    // Create the headless Service first so the StatefulSet's stable DNS
    // (`<slug>-0.<svc>.<ns>.svc.cluster.local`) resolves the moment the
    // pod comes up.
    await this.ensureService(ns, slug, input.imageType)

    const apps = k8sApps()
    try {
      await apps.createNamespacedStatefulSet({
        namespace: ns,
        body: {
          apiVersion: "apps/v1",
          kind: "StatefulSet",
          metadata: {
            name: slug,
            namespace: ns,
            labels: this.vmLabels(ownerId, input.imageType, input.agentType),
            annotations: { [VM_DISPLAY_NAME_ANNOTATION]: displayName },
          },
          spec: {
            serviceName: slug,
            replicas: 1,
            selector: { matchLabels: { "agent-platform/vm-slug": slug } },
            template: {
              metadata: {
                labels: {
                  ...this.vmLabels(ownerId, input.imageType, input.agentType),
                  "agent-platform/vm-slug": slug,
                },
              },
              spec: {
                containers: [
                  {
                    name: "vm",
                    image,
                    // Ports exposed by the agent-sandbox image:
                    //   8080 = code-server, 7681 = ttyd (xterm),
                    //   8787 = hermes-webui, 6901 = KasmVNC (desktop).
                    ports: [
                      { name: "http", containerPort: 8080 },
                      { name: "xterm", containerPort: 7681 },
                      { name: "webui", containerPort: 8787 },
                      ...(input.imageType === "desktop"
                        ? [{ name: "vnc", containerPort: 6901 }]
                        : []),
                    ],
                    env: [
                      { name: "VM_OWNER", value: ownerId },
                      { name: "VM_SLUG", value: slug },
                      { name: "VM_NAME", value: displayName },
                      { name: "VM_AGENT", value: input.agentType },
                      // Sub-path config picked up by the agent-sandbox
                      // image's supervisord (ttyd `-b`, KasmVNC
                      // `basepath`). code-server doesn't need the hint —
                      // strip-prefix at the Gateway is enough.
                      { name: "TTYD_BASE_PATH", value: `/vms/${slug}/term` },
                      { name: "KASM_BASE_PATH", value: `/vms/${slug}/vnc` },
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
        // randomSlug() collisions are astronomically unlikely; this
        // mostly fires when something else (a previous failed create)
        // left a leftover.
        throw new ConflictException(`VM "${slug}" already exists in ${ns}.`)
      }
      rethrowK8sError(err, `Failed to create VM "${slug}"`)
    }

    // One HTTPRoute on the console hostname with three path-based rules
    // (term/vnc/code) → backend ports. URLRewrite strips the
    // `/vms/<slug>/<svc>` prefix so each upstream sees `/`. Gateway
    // listener allows routes from all namespaces.
    await this.ensureHttpRoute(ns, slug, input.imageType)

    const vms = await this.listForOwner(ownerId)
    const created = vms.find((v) => v.slug === slug)
    if (!created) throw new NotFoundException("VM created but not found.")
    return created
  }

  // Delete by slug — the random ID we own. The display name is not
  // unique and not safe to look up by.
  async delete(ownerId: string, slug: string): Promise<void> {
    const cleanSlug = sanitizeLabel(slug)
    if (!cleanSlug) throw new BadRequestException("Invalid VM slug.")
    const ns = ownerNamespace(ownerId)
    const apps = k8sApps()
    const core = k8sCore()
    await apps
      .deleteNamespacedStatefulSet({ name: cleanSlug, namespace: ns })
      .catch((err: { code?: number; statusCode?: number }) => {
        if ((err.code ?? err.statusCode) === 404) return
        throw err
      })
    await core
      .deleteNamespacedService({ name: cleanSlug, namespace: ns })
      .catch(() => undefined)
    // PVCs created from volumeClaimTemplates aren't garbage-collected on
    // StatefulSet delete; remove them so storage isn't leaked.
    await core
      .deleteCollectionNamespacedPersistentVolumeClaim({
        namespace: ns,
        labelSelector: `agent-platform/vm-slug=${cleanSlug}`,
      })
      .catch(() => undefined)
    await this.deleteHttpRoute(ns, cleanSlug).catch(() => undefined)
  }

  // One HTTPRoute per VM, named after the slug, with path rules for
  // term/code (every VM) and vnc (desktop only). URLRewrite strips the
  // `/vms/<slug>/<svc>` prefix so each upstream sees the request at `/`.
  private async ensureHttpRoute(
    ns: string,
    slug: string,
    imageType: VmImageType,
  ): Promise<void> {
    const custom = k8sCustom()
    const rule = (svc: string, port: number) => ({
      matches: [
        { path: { type: "PathPrefix", value: `/vms/${slug}/${svc}` } },
      ],
      filters: [
        {
          type: "URLRewrite",
          urlRewrite: {
            path: { type: "ReplacePrefixMatch", replacePrefixMatch: "/" },
          },
        },
      ],
      backendRefs: [
        { group: "", kind: "Service", name: slug, port },
      ],
    })
    const rules = [rule("term", 7681), rule("code", 8080)]
    if (imageType === "desktop") rules.push(rule("vnc", 6901))

    const body = {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "HTTPRoute",
      metadata: {
        name: slug,
        namespace: ns,
        labels: { [VM_LABEL]: VM_LABEL_VALUE },
      },
      spec: {
        hostnames: [this.consoleHostname],
        parentRefs: [
          {
            group: "gateway.networking.k8s.io",
            kind: "Gateway",
            name: this.gatewayName,
            namespace: this.gatewayNamespace,
          },
        ],
        rules,
      },
    }
    try {
      await custom.createNamespacedCustomObject({
        group: "gateway.networking.k8s.io",
        version: "v1",
        namespace: ns,
        plural: "httproutes",
        body,
      })
    } catch (err: unknown) {
      const code = (err as { code?: number; statusCode?: number }).code
        ?? (err as { statusCode?: number }).statusCode
      if (code === 409) return // already exists, fine
      rethrowK8sError(err, `Failed to create HTTPRoute "${slug}"`)
    }
  }

  private async deleteHttpRoute(ns: string, name: string): Promise<void> {
    const custom = k8sCustom()
    await custom.deleteNamespacedCustomObject({
      group: "gateway.networking.k8s.io",
      version: "v1",
      namespace: ns,
      plural: "httproutes",
      name,
    })
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

  private async ensureService(
    ns: string,
    name: string,
    imageType: VmImageType,
  ): Promise<void> {
    const core = k8sCore()
    try {
      await core.readNamespacedService({ name, namespace: ns })
      return
    } catch (err: unknown) {
      const code = (err as { code?: number; statusCode?: number }).code
        ?? (err as { statusCode?: number }).statusCode
      if (code !== 404) throw err
    }
    const ports = [
      { name: "http", port: 8080, targetPort: 8080 },
      { name: "xterm", port: 7681, targetPort: 7681 },
      { name: "webui", port: 8787, targetPort: 8787 },
      ...(imageType === "desktop"
        ? [{ name: "vnc", port: 6901, targetPort: 6901 }]
        : []),
    ]
    try {
      await core.createNamespacedService({
        namespace: ns,
        body: {
          apiVersion: "v1",
          kind: "Service",
          metadata: { name, namespace: ns, labels: { [VM_LABEL]: VM_LABEL_VALUE } },
          spec: {
            clusterIP: "None",
            selector: { "agent-platform/vm-name": name },
            ports,
          },
        },
      })
    } catch (err) {
      rethrowK8sError(err, `Failed to create headless Service for VM "${name}"`)
    }
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
    metadata?: {
      name?: string
      namespace?: string
      labels?: Record<string, string>
      annotations?: Record<string, string>
      uid?: string
      creationTimestamp?: string | Date
    }
    status?: { readyReplicas?: number; replicas?: number }
  }): Vm {
    // The K8s resource name IS the slug — we set it that way at create.
    const slug = sts.metadata?.name ?? "unknown"
    const namespace = sts.metadata?.namespace ?? "unknown"
    const labels = sts.metadata?.labels ?? {}
    const annotations = sts.metadata?.annotations ?? {}
    const displayName = annotations[VM_DISPLAY_NAME_ANNOTATION] ?? slug
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
    const hostname = `${slug}.${this.vmDomain}`
    return {
      id: sts.metadata?.uid ?? `${namespace}/${slug}`,
      slug,
      name: displayName,
      owner,
      namespace,
      imageType,
      agentType,
      status,
      hostname,
      createdAt,
      // Path-based on the console hostname → reuses its trusted cert.
      // The HTTPRoute does the URL rewrite to drop the prefix.
      xtermUrl: `https://${this.consoleHostname}/vms/${slug}/term/`,
      codeUrl: `https://${this.consoleHostname}/vms/${slug}/code/`,
      vncUrl:
        imageType === "desktop"
          ? `https://${this.consoleHostname}/vms/${slug}/vnc/`
          : null,
    }
  }
}
