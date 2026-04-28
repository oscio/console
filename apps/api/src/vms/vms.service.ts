import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { randomBytes } from "node:crypto"
import { authPool } from "@workspace/auth"
import { OpenFgaService } from "../openfga/openfga.service"
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
  constructor(private readonly fga: OpenFgaService) {}

  private readonly imageBase = process.env.VM_IMAGE_BASE ?? ""
  private readonly imageDesktop = process.env.VM_IMAGE_DESKTOP ?? ""
  private readonly vmDomain = process.env.VM_DOMAIN ?? "vm.localhost"
  // Gateway API parent ref for per-VM HTTPRoutes. Defaults match the
  // dev cluster's `platform-gateway` in `platform-traefik`.
  private readonly gatewayName =
    process.env.VM_GATEWAY_NAME ?? "platform-gateway"
  private readonly gatewayNamespace =
    process.env.VM_GATEWAY_NAMESPACE ?? "platform-traefik"
  // ForwardAuth chain: oauth2-proxy (session) → optional FGA ownership
  // check. Traefik resolves Middleware refs only within the HTTPRoute's
  // namespace, so we clone tiny Middlewares into each VM namespace
  // pointing at these URLs. Empty oauth URL = no auth gate at all.
  private readonly authForwardUrl = process.env.VM_AUTH_FORWARD_URL ?? ""
  private readonly authOwnershipUrl =
    process.env.VM_AUTH_OWNERSHIP_URL ?? ""
  private readonly authOauthMiddleware = "vm-auth-oauth"
  private readonly authFgaMiddleware = "vm-auth-fga"

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

    // Per-namespace ForwardAuth Middlewares, cloned once per VM ns.
    // First gate is oauth2-proxy (session); second is the optional
    // console-api ownership check. Skipped when no oauth URL is set.
    if (this.authForwardUrl) {
      await this.ensureAuthMiddleware(
        ns,
        this.authOauthMiddleware,
        this.authForwardUrl,
      )
    }
    if (this.authOwnershipUrl) {
      await this.ensureAuthMiddleware(
        ns,
        this.authFgaMiddleware,
        this.authOwnershipUrl,
      )
    }

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
                      // Point `docker` (CLI) at the DinD sidecar over
                      // the shared pod-localhost. Same pattern as the
                      // forgejo-runner pod.
                      { name: "DOCKER_HOST", value: "tcp://127.0.0.1:2375" },
                    ],
                    volumeMounts: [
                      { name: "data", mountPath: "/home/agent" },
                    ],
                  },
                  {
                    // Docker-in-Docker sidecar — listens plaintext on
                    // 127.0.0.1:2375 (pod network namespace isolates).
                    // --mtu=1450 matches the Flannel/k3s overlay so
                    // build-container TLS handshakes don't black-hole
                    // (same fix we applied to forgejo-runner).
                    name: "dind",
                    image: "docker:24-dind",
                    args: ["--mtu=1450"],
                    env: [
                      // Empty DOCKER_TLS_CERTDIR → daemon binds plain
                      // tcp://0.0.0.0:2375 (pod network is private).
                      { name: "DOCKER_TLS_CERTDIR", value: "" },
                    ],
                    securityContext: {
                      privileged: true,
                      runAsUser: 0,
                    },
                    volumeMounts: [
                      // /var/lib/docker on the VM's PVC so images +
                      // build cache survive pod restarts. Sub-path
                      // keeps it separate from the agent's /home.
                      { name: "data", mountPath: "/var/lib/docker", subPath: "docker" },
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

    // Per-host HTTPRoutes — one hostname per service, all under the
    // `*.vm.<domain>` wildcard listener. Each upstream serves at `/`,
    // which is what code-server / ttyd / KasmVNC expect (no sub-path
    // gymnastics, WebSockets work as-is). The user trusts the platform
    // root CA once at the OS level and every host's cert is accepted.
    await this.ensureHttpRoute(ns, slug, "term", 7681)
    await this.ensureHttpRoute(ns, slug, "code", 8080)
    if (input.imageType === "desktop") {
      await this.ensureHttpRoute(ns, slug, "vnc", 6901)
    }

    // Stamp the OpenFGA ownership tuple. This is what the per-VM
    // ForwardAuth check (/vms/auth) reads to decide whether a logged-
    // in user can reach this VM's URLs.
    await this.fga.grantVmOwner(slug, ownerId).catch((err) => {
      // Don't roll back the K8s resources — owner can still delete via
      // the slug from the API. Log and surface the failure.
      throw new Error(
        `VM ${slug} created but FGA owner tuple write failed: ${(err as Error).message}`,
      )
    })

    const vms = await this.listForOwner(ownerId)
    const created = vms.find((v) => v.slug === slug)
    if (!created) throw new NotFoundException("VM created but not found.")
    return created
  }

  // Used by the ForwardAuth endpoint /vms/auth. Accepts the email that
  // oauth2-proxy forwards as `X-Auth-Request-Email`, looks up the
  // better-auth user id (FGA tuples are written with that id), and
  // checks ownership against the slug derived from the request host.
  async canAccessByEmail(email: string, slug: string): Promise<boolean> {
    const cleanSlug = sanitizeLabel(slug)
    if (!cleanSlug || !email) return false
    const { rows } = await authPool.query<{ id: string }>(
      `SELECT id FROM "user" WHERE lower(email) = lower($1) LIMIT 1`,
      [email],
    )
    const userId = rows[0]?.id
    if (!userId) return false
    return this.fga.canAccessVm(userId, cleanSlug)
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
    // Tear down per-service HTTPRoutes — term/code always, vnc when present.
    for (const svc of ["term", "code", "vnc"]) {
      await this.deleteHttpRoute(ns, `${cleanSlug}-${svc}`).catch(
        () => undefined,
      )
    }
    // Drop every owner tuple. listVmOwners covers the case where the
    // VM was shared with multiple users (no UI for this yet, but the
    // FGA model already supports it).
    const owners = await this.fga.listVmOwners(cleanSlug).catch(() => [])
    for (const u of owners) {
      await this.fga.revokeVmOwner(cleanSlug, u).catch(() => undefined)
    }
  }

  // One HTTPRoute per service hostname, e.g. <slug>-term.vm.<domain>
  // → Service:<port>. Each upstream serves at `/` so WebSocket asset
  // URLs work without rewriting.
  private async ensureHttpRoute(
    ns: string,
    slug: string,
    svc: "term" | "code" | "vnc",
    port: number,
  ): Promise<void> {
    const custom = k8sCustom()
    const name = `${slug}-${svc}`
    const hostname = `${slug}-${svc}.${this.vmDomain}`
    // ExtensionRef chain: oauth2-proxy first (sets X-Auth-Request-*
    // headers), then console-api ownership check uses those headers.
    // Both Middlewares are cloned into this ns by ensureAuthMiddleware.
    const filterFor = (name: string) => ({
      type: "ExtensionRef",
      extensionRef: { group: "traefik.io", kind: "Middleware", name },
    })
    const authFilters: Array<ReturnType<typeof filterFor>> = []
    if (this.authForwardUrl) authFilters.push(filterFor(this.authOauthMiddleware))
    if (this.authOwnershipUrl) authFilters.push(filterFor(this.authFgaMiddleware))
    const body = {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "HTTPRoute",
      metadata: {
        name,
        namespace: ns,
        labels: { [VM_LABEL]: VM_LABEL_VALUE },
      },
      spec: {
        hostnames: [hostname],
        parentRefs: [
          {
            group: "gateway.networking.k8s.io",
            kind: "Gateway",
            name: this.gatewayName,
            namespace: this.gatewayNamespace,
          },
        ],
        rules: [
          {
            matches: [{ path: { type: "PathPrefix", value: "/" } }],
            filters: authFilters,
            backendRefs: [
              { group: "", kind: "Service", name: slug, port },
            ],
          },
        ],
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
      rethrowK8sError(err, `Failed to create HTTPRoute "${name}"`)
    }
  }

  // Drops a `Middleware` (Traefik) in the given namespace pointing at
  // a forwardAuth target. Idempotent — 409 = already exists.
  private async ensureAuthMiddleware(
    ns: string,
    name: string,
    address: string,
  ): Promise<void> {
    const custom = k8sCustom()
    const body = {
      apiVersion: "traefik.io/v1alpha1",
      kind: "Middleware",
      metadata: {
        name,
        namespace: ns,
        labels: { [VM_LABEL]: VM_LABEL_VALUE },
      },
      spec: {
        forwardAuth: {
          address,
          trustForwardHeader: true,
          authResponseHeaders: [
            "X-Auth-Request-User",
            "X-Auth-Request-Email",
            "X-Auth-Request-Groups",
            "Authorization",
          ],
        },
      },
    }
    try {
      await custom.createNamespacedCustomObject({
        group: "traefik.io",
        version: "v1alpha1",
        namespace: ns,
        plural: "middlewares",
        body,
      })
    } catch (err: unknown) {
      const code = (err as { code?: number; statusCode?: number }).code
        ?? (err as { statusCode?: number }).statusCode
      if (code === 409) return
      rethrowK8sError(err, `Failed to create auth Middleware "${name}" in ${ns}`)
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
            selector: { "agent-platform/vm-slug": name },
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
      // Per-host URLs under the `*.vm.<domain>` wildcard listener. Each
      // upstream serves at `/`, so WebSockets and absolute asset URLs
      // work as-is. Browsers need the platform root CA trusted once
      // (sudo security add-trusted-cert ...).
      xtermUrl: `https://${slug}-term.${this.vmDomain}`,
      codeUrl: `https://${slug}-code.${this.vmDomain}`,
      vncUrl:
        imageType === "desktop"
          ? `https://${slug}-vnc.${this.vmDomain}`
          : null,
    }
  }
}
