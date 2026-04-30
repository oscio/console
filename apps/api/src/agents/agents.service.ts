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
import { RESOURCE_NS } from "../vms/vms.service"
import { k8sApps, k8sCore, k8sCustom } from "./k8s.client"
import {
  Agent,
  AGENT_BOUND_TO_VM_LABEL,
  AGENT_DISPLAY_NAME_ANNOTATION,
  AGENT_LABEL,
  AGENT_LABEL_VALUE,
  AGENT_OWNER_LABEL,
  AGENT_PORT,
  AGENT_TYPE_LABEL,
  AgentStatus,
  AgentType,
  CreateAgentInput,
  GLOBAL_AGENT_ENV_SECRET,
} from "./agents.types"

function jsonPointerLabel(label: string): string {
  return `/${label.replace(/~/g, "~0").replace(/\//g, "~1")}`
}

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

  // Admin-only: every agent in the unified resource namespace.
  // VM-attached agents are now their own StatefulSets (separate
  // pods + SSH shim), so a single list selector covers both modes.
  async listAll(): Promise<Agent[]> {
    const apps = k8sApps()
    const res = await apps
      .listNamespacedStatefulSet({
        namespace: RESOURCE_NS,
        labelSelector: `${AGENT_LABEL}=${AGENT_LABEL_VALUE}`,
      })
      .catch(() => ({ items: [] }))
    return (res.items ?? []).map((sts) => this.toAgent(sts))
  }

  // List all agents attached to a particular VM. Used by VmsService
  // delete to cascade-clean attached sidecars (now in their own pods).
  async listForVm(vmSlug: string): Promise<Agent[]> {
    const apps = k8sApps()
    const res = await apps
      .listNamespacedStatefulSet({
        namespace: RESOURCE_NS,
        labelSelector: `${AGENT_LABEL}=${AGENT_LABEL_VALUE},${AGENT_BOUND_TO_VM_LABEL}=${sanitizeLabel(vmSlug)}`,
      })
      .catch(() => ({ items: [] }))
    return (res.items ?? []).map((sts) => this.toAgent(sts))
  }

  async listForOwner(ownerId: string): Promise<Agent[]> {
    const slugs = await this.fga.listAccessibleAgents(ownerId)
    if (slugs.length === 0) return []
    const apps = k8sApps()
    const results = await Promise.all(
      slugs.map((slug) =>
        apps
          .readNamespacedStatefulSet({ name: slug, namespace: RESOURCE_NS })
          .catch(() => null),
      ),
    )
    return results
      .filter((sts): sts is NonNullable<typeof sts> => sts !== null)
      .map((sts) => this.toAgent(sts))
  }

  async create(ownerId: string, input: CreateAgentInput): Promise<Agent> {
    const displayName = input.name.trim()
    if (!displayName) throw new BadRequestException("name is required")
    if (displayName.length > 200) {
      throw new BadRequestException("name must be 200 characters or fewer")
    }
    const slug = randomSlug()
    const ns = RESOURCE_NS
    const image = this.requireImage()

    // Grant FGA owner tuple first so a partial create still surfaces
    // in /agents and can be cleaned up via the normal delete flow.
    await this.fga.grantAgentOwner(slug, ownerId).catch((err) => {
      throw new Error(
        `Failed to grant agent owner tuple for ${slug}: ${(err as Error).message}`,
      )
    })

    await this.ensureNamespace(ns)

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

    const isBound = !!input.boundToVm
    if (isBound) {
      if (!input.workspaceVolumeSlug) {
        throw new BadRequestException(
          "boundToVm requires workspaceVolumeSlug — caller must pass the VM's PVC name.",
        )
      }
      if (!input.sshKeySecretName) {
        throw new BadRequestException(
          "boundToVm requires sshKeySecretName — caller must create the SSH key Secret.",
        )
      }
    }

    // Two env profiles, two pod-spec profiles:
    //
    //   Headless: container fs is the workspace, no PVC, no SSH, no
    //   pod affinity. Pod restart wipes session state.
    //
    //   Bound to VM: SSH shim wrapping bash → workspace pod's sshd
    //   over the cluster network. Workspace PVC mounted at the same
    //   path the workspace container sees, so direct fs reads from
    //   the agent runtime (Claude Code's Read tool, etc.) Just Work.
    //   podAffinity pins the agent to the VM's node since RWO PVC
    //   demands it.
    const env: Array<{ name: string; value: string }> = [
      { name: "AGENT_OWNER", value: ownerId },
      { name: "AGENT_SLUG", value: slug },
      { name: "AGENT_NAME", value: displayName },
      { name: "AGENT_TYPE", value: input.agentType },
      { name: "AGENT_PORT", value: String(AGENT_PORT) },
      { name: "AGENT_HOST", value: "0.0.0.0" },
    ]
    let volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }> = []
    let volumes: Array<Record<string, unknown>> = []
    let affinity: Record<string, unknown> | undefined

    if (isBound) {
      env.push(
        { name: "AGENT_USE_SSH_SHIM", value: "true" },
        { name: "SSH_HOST", value: `${input.boundToVm}.${RESOURCE_NS}.svc.cluster.local` },
        { name: "SSH_PORT", value: "22" },
        { name: "SSH_USER", value: "coder" },
        { name: "SSH_KEY", value: "/etc/agent-ssh/id_ed25519" },
        // Same path the VM workspace mounts at. The wrapper's
        // WORKSPACE_DIR points here so events.jsonl + the user's
        // project files live on the same disk.
        { name: "WORKSPACE_DIR", value: "/home/coder/workspace" },
      )
      volumeMounts = [
        { name: "workspace", mountPath: "/home/coder/workspace" },
        // The agent runs as uid 1000 but Secret-mounted files are
        // owned by root with mode 0400, so the agent can't read its
        // own SSH key. We can't fix that with `defaultMode` (ssh
        // rejects group-readable keys with "bad permissions") or
        // `fsGroup` (Secrets aren't chowned by fsGroup the way PVCs
        // are). Instead, the init container below copies the key
        // into this in-memory emptyDir with the right ownership.
        { name: "agent-ssh", mountPath: "/etc/agent-ssh", readOnly: true },
      ]
      volumes = [
        {
          name: "workspace",
          persistentVolumeClaim: { claimName: input.workspaceVolumeSlug },
        },
        {
          name: "agent-ssh-src",
          secret: {
            secretName: input.sshKeySecretName,
            defaultMode: 0o400,
            items: [{ key: "id_ed25519", path: "id_ed25519" }],
          },
        },
        {
          name: "agent-ssh",
          emptyDir: { medium: "Memory" },
        },
      ]
      affinity = {
        podAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: [
            {
              labelSelector: {
                matchLabels: { "agent-platform/vm-slug": input.boundToVm },
              },
              topologyKey: "kubernetes.io/hostname",
            },
          ],
        },
      }
    } else {
      env.push(
        { name: "AGENT_USE_SSH_SHIM", value: "false" },
        // Headless agents are intentionally ephemeral. Container fs.
        { name: "WORKSPACE_DIR", value: "/home/agent/workspace" },
      )
    }

    // Per-agent env Secret. Today it only carries the user's chosen
    // model (ZEROCLAW_DEFAULT_MODEL), but the same Secret is the
    // place to add any future per-pod settings without touching the
    // pod spec — entrypoint reads via envFrom. Skipped when there's
    // nothing pod-specific to set (hermes, or zeroclaw with default
    // model). Provider credentials (OPENROUTER_API_KEY etc.) live in
    // the cluster-wide GLOBAL_AGENT_ENV_SECRET, attached separately.
    const perPodEnv: Record<string, string> = {}
    if (input.agentType === "zeroclaw" && input.model) {
      perPodEnv.ZEROCLAW_DEFAULT_MODEL = input.model
    }
    let envFromSecretName: string | null = null
    if (Object.keys(perPodEnv).length > 0) {
      envFromSecretName = `agent-env-${slug}`
      await k8sCore()
        .createNamespacedSecret({
          namespace: ns,
          body: {
            apiVersion: "v1",
            kind: "Secret",
            metadata: {
              name: envFromSecretName,
              namespace: ns,
              labels: this.agentLabels(ownerId, input.agentType, input.boundToVm),
            },
            type: "Opaque",
            stringData: perPodEnv,
          },
        })
        .catch((err) =>
          rethrowK8sError(err, `Failed to create env Secret for ${slug}`),
        )
    }

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
            labels: this.agentLabels(ownerId, input.agentType, input.boundToVm),
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
                  ...this.agentLabels(ownerId, input.agentType, input.boundToVm),
                  "agent-platform/agent-slug": slug,
                },
              },
              spec: ({
                ...(isBound
                  ? {
                      initContainers: [
                        {
                          name: "agent-ssh-prep",
                          image: "busybox:1.37",
                          command: ["sh", "-c"],
                          args: [
                            "install -m 0400 -o 1000 -g 1000 /etc/agent-ssh-src/id_ed25519 /etc/agent-ssh/id_ed25519",
                          ],
                          volumeMounts: [
                            { name: "agent-ssh-src", mountPath: "/etc/agent-ssh-src", readOnly: true },
                            { name: "agent-ssh", mountPath: "/etc/agent-ssh" },
                          ],
                        },
                      ],
                    }
                  : {}),
                containers: [
                  {
                    name: "agent",
                    image,
                    // AGENT_TYPE picks the wrapper's adapter;
                    // AGENT_PORT is the FastAPI listen port.
                    ports: [{ name: "http", containerPort: AGENT_PORT }],
                    env,
                    // Always attach the cluster-wide secret (optional
                    // so the pod still schedules even before an admin
                    // populates it). Per-agent secret is layered on
                    // top — last write wins on duplicate keys, but
                    // we only put pod-specific overrides there.
                    envFrom: [
                      {
                        secretRef: {
                          name: GLOBAL_AGENT_ENV_SECRET,
                          optional: true,
                        },
                      },
                      ...(envFromSecretName
                        ? [{ secretRef: { name: envFromSecretName } }]
                        : []),
                    ],
                    volumeMounts,
                  },
                ],
                ...(volumes.length ? { volumes } : {}),
                ...(affinity ? { affinity } : {}),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } as unknown as any),
            },
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

  // Update the agent's display name. Slug is immutable; only the
  // StatefulSet annotation moves. FGA-gated.
  async rename(ownerId: string, slug: string, newName: string): Promise<void> {
    const cleanSlug = sanitizeLabel(slug)
    if (!cleanSlug) throw new BadRequestException("Invalid agent slug.")
    const trimmed = newName.trim()
    if (!trimmed) throw new BadRequestException("name is required")
    if (trimmed.length > 200) {
      throw new BadRequestException("name must be 200 characters or fewer")
    }
    const allowed = await this.fga.canAccessAgent(ownerId, cleanSlug)
    if (!allowed) {
      throw new NotFoundException(`Agent "${cleanSlug}" not found.`)
    }
    const path = jsonPointerLabel(AGENT_DISPLAY_NAME_ANNOTATION)
    await k8sApps()
      .patchNamespacedStatefulSet({
        name: cleanSlug,
        namespace: RESOURCE_NS,
        body: [
          { op: "add", path: `/metadata/annotations${path}`, value: trimmed },
        ] as unknown as object,
      })
      .catch((err) => rethrowK8sError(err, `Failed to rename agent "${cleanSlug}"`))
  }

  async delete(ownerId: string, slug: string): Promise<void> {
    const cleanSlug = sanitizeLabel(slug)
    if (!cleanSlug) throw new BadRequestException("Invalid agent slug.")
    const allowed = await this.fga.canAccessAgent(ownerId, cleanSlug)
    if (!allowed) {
      throw new NotFoundException(`Agent "${cleanSlug}" not found.`)
    }
    // Block direct delete on attached agents — they're cleaned up
    // by VM delete (cascade). Caller should /vms/:slug instead.
    const sts = await k8sApps()
      .readNamespacedStatefulSet({ name: cleanSlug, namespace: RESOURCE_NS })
      .catch(() => null)
    const boundToVm = sts?.metadata?.labels?.[AGENT_BOUND_TO_VM_LABEL]
    if (boundToVm) {
      throw new ConflictException(
        `Agent "${cleanSlug}" is attached to VM "${boundToVm}". Delete the VM instead.`,
      )
    }
    await this.tearDownResources(cleanSlug)
  }

  // Cascade entry point used by VmsService.delete. Skips the
  // bound-to-VM guard (the VM IS being deleted) but still revokes
  // FGA tuples + tears down k8s. Callers are responsible for FGA
  // ownership checks at their own boundary.
  async deleteAttachedForCascade(slug: string): Promise<void> {
    const cleanSlug = sanitizeLabel(slug)
    if (!cleanSlug) return
    await this.tearDownResources(cleanSlug)
  }

  private async tearDownResources(cleanSlug: string): Promise<void> {
    const ns = RESOURCE_NS
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
    // Per-agent env Secret. May not exist (only created when caller
    // passed input.env at create time) — 404 is fine.
    await core
      .deleteNamespacedSecret({ name: `agent-env-${cleanSlug}`, namespace: ns })
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

  private async ensureNamespace(ns: string): Promise<void> {
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
      body: { metadata: { name: ns } },
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
    boundToVm?: string,
  ): Record<string, string> {
    const labels: Record<string, string> = {
      [AGENT_LABEL]: AGENT_LABEL_VALUE,
      [AGENT_OWNER_LABEL]: sanitizeLabel(ownerId),
      [AGENT_TYPE_LABEL]: agentType,
    }
    if (boundToVm) {
      labels[AGENT_BOUND_TO_VM_LABEL] = sanitizeLabel(boundToVm)
    }
    return labels
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
    const ready = sts.status?.readyReplicas ?? 0
    const replicas = sts.status?.replicas ?? 0
    let status: AgentStatus = "Pending"
    if (ready > 0) status = "Running"
    else if (replicas > 0 && ready === 0) status = "Pending"
    else status = "Unknown"
    const ts = sts.metadata?.creationTimestamp
    const createdAt =
      ts instanceof Date ? ts.toISOString() : (ts ?? new Date().toISOString())

    const displayName = annotations[AGENT_DISPLAY_NAME_ANNOTATION] ?? slug
    const owner = labels[AGENT_OWNER_LABEL] ?? "unknown"
    const agentType = (labels[AGENT_TYPE_LABEL] as AgentType) ?? "hermes"
    const boundToVm = labels[AGENT_BOUND_TO_VM_LABEL] || null
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
      // Bound agents are reached via /agents/<slug>/chat/... only —
      // no public hostname plumbed for them yet.
      gatewayUrl: boundToVm ? "" : this.launchUrl(`https://${hostname}`),
      boundToVm,
    }
  }
}
