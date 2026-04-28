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
  Agent,
  AGENT_DISPLAY_NAME_ANNOTATION,
  AGENT_LABEL,
  AGENT_LABEL_VALUE,
  AGENT_OWNER_LABEL,
  AGENT_PORT,
  AGENT_TYPE_LABEL,
  AgentStatus,
  AgentType,
  CreateAgentInput,
} from "./agents.types"

const NS_PREFIX = "resource-agent-"

function sanitizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
}

// DNS-1035-valid slug, 11 chars, prefixed `agent-` so VM and agent
// hosts never collide on the wildcard listener.
function randomSlug(): string {
  return `agent-${randomBytes(4).toString("hex")}`
}

function ownerNamespace(ownerId: string): string {
  const slug = sanitizeLabel(ownerId)
  if (!slug) throw new BadRequestException("Invalid owner id")
  return `${NS_PREFIX}${slug}`
}

// Surface 4xx K8s errors with their original message + status. Same
// pattern as vms.service — without this, ApiException turns into a
// blank 500 in the UI.
function rethrowK8sError(err: unknown, fallback: string): never {
  const e = err as {
    code?: number
    statusCode?: number
    body?: unknown
    message?: string
  }
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
export class AgentsService {
  constructor(private readonly fga: OpenFgaService) {}

  // Same agent-sandbox image VMs use, plus the entrypoint-*.sh layer
  // baked by services/agents/Dockerfile. The base image's ttyd /
  // code-server / hermes-webui / VNC are present but unused — only
  // port 8000 is exposed and routed.
  private readonly image = process.env.AGENT_IMAGE ?? ""
  private readonly agentsDomain =
    process.env.AGENTS_DOMAIN ?? "agents.localhost"
  private readonly oauthProxyUrl = process.env.OAUTH_PROXY_URL ?? ""
  private readonly gatewayName =
    process.env.AGENT_GATEWAY_NAME ?? "platform-gateway"
  private readonly gatewayNamespace =
    process.env.AGENT_GATEWAY_NAMESPACE ?? "platform-traefik"
  // ForwardAuth chain: oauth2-proxy /oauth2/auth → /agents/auth.
  // Same shape as VMs, separate URL env so admins can swap targets
  // without touching VM auth.
  private readonly authForwardUrl =
    process.env.AGENT_AUTH_FORWARD_URL ?? ""
  private readonly authOwnershipUrl =
    process.env.AGENT_AUTH_OWNERSHIP_URL ?? ""
  private readonly authOauthMiddleware = "agent-auth-oauth"
  private readonly authFgaMiddleware = "agent-auth-fga"

  private requireImage(): string {
    if (!this.image) {
      throw new BadRequestException(
        "Agents image is not configured (set AGENT_IMAGE).",
      )
    }
    return this.image
  }

  // List agents across all `resource-agent-*` namespaces. Same
  // cluster-wide listing trick as VMs — survives unfamiliar owners
  // and stays cheap.
  async listAll(): Promise<Agent[]> {
    const apps = k8sApps()
    const res = await apps.listStatefulSetForAllNamespaces({
      labelSelector: `${AGENT_LABEL}=${AGENT_LABEL_VALUE}`,
    })
    return (res.items ?? []).map((sts) => this.toAgent(sts))
  }

  async listForOwner(ownerId: string): Promise<Agent[]> {
    const apps = k8sApps()
    const ns = ownerNamespace(ownerId)
    const res = await apps
      .listNamespacedStatefulSet({
        namespace: ns,
        labelSelector: `${AGENT_LABEL}=${AGENT_LABEL_VALUE}`,
      })
      .catch((err: { code?: number; statusCode?: number }) => {
        if ((err.code ?? err.statusCode) === 404) return { items: [] }
        throw err
      })
    return (res.items ?? []).map((sts) => this.toAgent(sts))
  }

  async create(ownerId: string, input: CreateAgentInput): Promise<Agent> {
    const displayName = input.name.trim()
    if (!displayName) throw new BadRequestException("name is required")
    if (displayName.length > 200) {
      throw new BadRequestException("name must be 200 characters or fewer")
    }
    const slug = randomSlug()
    const ns = ownerNamespace(ownerId)
    const image = this.requireImage()
    const storage = input.storageSize ?? "10Gi"

    await this.ensureNamespace(ns, ownerId)

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

    await this.ensureService(ns, slug)

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
            labels: this.agentLabels(ownerId, input.agentType),
            annotations: { [AGENT_DISPLAY_NAME_ANNOTATION]: displayName },
          },
          spec: {
            serviceName: slug,
            replicas: 1,
            selector: {
              matchLabels: { "agent-platform/agent-slug": slug },
            },
            template: {
              metadata: {
                labels: {
                  ...this.agentLabels(ownerId, input.agentType),
                  "agent-platform/agent-slug": slug,
                },
              },
              spec: {
                containers: [
                  {
                    name: "agent",
                    image,
                    // Only the agent gateway. AGENT_TYPE picks the
                    // entrypoint-*.sh runner; AGENT_PORT fixes the
                    // listening port so the Service / HTTPRoute /
                    // pod all agree.
                    ports: [
                      { name: "http", containerPort: AGENT_PORT },
                    ],
                    env: [
                      { name: "AGENT_OWNER", value: ownerId },
                      { name: "AGENT_SLUG", value: slug },
                      { name: "AGENT_NAME", value: displayName },
                      { name: "AGENT_TYPE", value: input.agentType },
                      { name: "AGENT_PORT", value: String(AGENT_PORT) },
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
      const code =
        (err as { code?: number; statusCode?: number }).code ??
        (err as { statusCode?: number }).statusCode
      if (code === 409) {
        throw new ConflictException(
          `Agent "${slug}" already exists in ${ns}.`,
        )
      }
      rethrowK8sError(err, `Failed to create agent "${slug}"`)
    }

    // Single HTTPRoute → port 8000. Hostname is `<slug>.<agentsDomain>`
    // (no service suffix — there is only one service).
    await this.ensureHttpRoute(ns, slug)

    await this.fga.grantAgentOwner(slug, ownerId).catch((err) => {
      throw new Error(
        `Agent ${slug} created but FGA owner tuple write failed: ${(err as Error).message}`,
      )
    })

    const agents = await this.listForOwner(ownerId)
    const created = agents.find((a) => a.slug === slug)
    if (!created) throw new NotFoundException("Agent created but not found.")
    return created
  }

  // Used by Traefik forwardAuth on /agents/auth. oauth2-proxy passes
  // the email; we look up the better-auth user id and ask FGA.
  async canAccessByEmail(email: string, slug: string): Promise<boolean> {
    const cleanSlug = sanitizeLabel(slug)
    if (!cleanSlug || !email) return false
    const { rows } = await authPool.query<{ id: string }>(
      `SELECT id FROM "user" WHERE lower(email) = lower($1) LIMIT 1`,
      [email],
    )
    const userId = rows[0]?.id
    if (!userId) return false
    return this.fga.canAccessAgent(userId, cleanSlug)
  }

  async delete(ownerId: string, slug: string): Promise<void> {
    const cleanSlug = sanitizeLabel(slug)
    if (!cleanSlug) throw new BadRequestException("Invalid agent slug.")
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
    await core
      .deleteCollectionNamespacedPersistentVolumeClaim({
        namespace: ns,
        labelSelector: `agent-platform/agent-slug=${cleanSlug}`,
      })
      .catch(() => undefined)
    await this.deleteHttpRoute(ns, cleanSlug).catch(() => undefined)
    const owners = await this.fga
      .listAgentOwners(cleanSlug)
      .catch(() => [])
    for (const u of owners) {
      await this.fga.revokeAgentOwner(cleanSlug, u).catch(() => undefined)
    }
  }

  private async ensureHttpRoute(ns: string, slug: string): Promise<void> {
    const custom = k8sCustom()
    const name = slug
    const hostname = `${slug}.${this.agentsDomain}`
    const filterFor = (name: string) => ({
      type: "ExtensionRef",
      extensionRef: { group: "traefik.io", kind: "Middleware", name },
    })
    const authFilters: Array<ReturnType<typeof filterFor>> = []
    if (this.authForwardUrl)
      authFilters.push(filterFor(this.authOauthMiddleware))
    if (this.authOwnershipUrl)
      authFilters.push(filterFor(this.authFgaMiddleware))
    const body = {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "HTTPRoute",
      metadata: {
        name,
        namespace: ns,
        labels: { [AGENT_LABEL]: AGENT_LABEL_VALUE },
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
              { group: "", kind: "Service", name: slug, port: AGENT_PORT },
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
      const code =
        (err as { code?: number; statusCode?: number }).code ??
        (err as { statusCode?: number }).statusCode
      if (code === 409) return
      rethrowK8sError(err, `Failed to create HTTPRoute "${name}"`)
    }
  }

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
        labels: { [AGENT_LABEL]: AGENT_LABEL_VALUE },
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
      const code =
        (err as { code?: number; statusCode?: number }).code ??
        (err as { statusCode?: number }).statusCode
      if (code === 409) return
      rethrowK8sError(
        err,
        `Failed to create auth Middleware "${name}" in ${ns}`,
      )
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
      const code =
        (err as { code?: number; statusCode?: number }).code ??
        (err as { statusCode?: number }).statusCode
      if (code !== 404) throw err
    }
    await core.createNamespace({
      body: {
        metadata: {
          name: ns,
          labels: {
            [AGENT_LABEL]: "agent-namespace",
            [AGENT_OWNER_LABEL]: sanitizeLabel(ownerId),
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
      const code =
        (err as { code?: number; statusCode?: number }).code ??
        (err as { statusCode?: number }).statusCode
      if (code !== 404) throw err
    }
    try {
      await core.createNamespacedService({
        namespace: ns,
        body: {
          apiVersion: "v1",
          kind: "Service",
          metadata: {
            name,
            namespace: ns,
            labels: { [AGENT_LABEL]: AGENT_LABEL_VALUE },
          },
          spec: {
            clusterIP: "None",
            selector: { "agent-platform/agent-slug": name },
            ports: [
              { name: "http", port: AGENT_PORT, targetPort: AGENT_PORT },
            ],
          },
        },
      })
    } catch (err) {
      rethrowK8sError(
        err,
        `Failed to create headless Service for agent "${name}"`,
      )
    }
  }

  private agentLabels(
    ownerId: string,
    agentType: AgentType,
  ): Record<string, string> {
    return {
      [AGENT_LABEL]: AGENT_LABEL_VALUE,
      [AGENT_OWNER_LABEL]: sanitizeLabel(ownerId),
      [AGENT_TYPE_LABEL]: agentType,
    }
  }

  private launchUrl(target: string): string {
    if (!this.oauthProxyUrl) return target
    return `${this.oauthProxyUrl}/oauth2/start?rd=${encodeURIComponent(target)}`
  }

  private toAgent(sts: {
    metadata?: {
      name?: string
      namespace?: string
      labels?: Record<string, string>
      annotations?: Record<string, string>
      uid?: string
      creationTimestamp?: string | Date
    }
    status?: { readyReplicas?: number; replicas?: number }
  }): Agent {
    const slug = sts.metadata?.name ?? "unknown"
    const namespace = sts.metadata?.namespace ?? "unknown"
    const labels = sts.metadata?.labels ?? {}
    const annotations = sts.metadata?.annotations ?? {}
    const displayName = annotations[AGENT_DISPLAY_NAME_ANNOTATION] ?? slug
    const owner = labels[AGENT_OWNER_LABEL] ?? "unknown"
    const agentType = (labels[AGENT_TYPE_LABEL] as AgentType) ?? "hermes"
    const ready = sts.status?.readyReplicas ?? 0
    const replicas = sts.status?.replicas ?? 0
    let status: AgentStatus = "Pending"
    if (ready > 0) status = "Running"
    else if (replicas > 0 && ready === 0) status = "Pending"
    else status = "Unknown"
    const ts = sts.metadata?.creationTimestamp
    const createdAt =
      ts instanceof Date ? ts.toISOString() : (ts ?? new Date().toISOString())
    const hostname = `${slug}.${this.agentsDomain}`
    return {
      id: sts.metadata?.uid ?? `${namespace}/${slug}`,
      slug,
      name: displayName,
      owner,
      namespace,
      agentType,
      status,
      hostname,
      createdAt,
      gatewayUrl: this.launchUrl(`https://${hostname}`),
    }
  }
}
