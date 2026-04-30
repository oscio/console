import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { randomBytes } from "node:crypto"
import { authPool } from "@workspace/auth"
import { AgentsService } from "../agents/agents.service"
import { generateAgentKeypair } from "../agents/sshkey"
import { LoadBalancersService } from "../loadbalancers/loadbalancers.service"
import { OpenFgaService } from "../openfga/openfga.service"
import { VolumesService } from "../volumes/volumes.service"
import { k8sApps, k8sCore, k8sCustom, k8sRbac } from "./k8s.client"
import {
  CreateVmInput,
  Vm,
  VM_AGENT_TYPE_LABEL,
  VM_DATA_MOUNT_PATH,
  VM_DATA_VOLUME_NAME,
  VM_DEFAULTS,
  VM_DISPLAY_NAME_ANNOTATION,
  VM_IMAGE_TYPE_LABEL,
  VM_LABEL,
  VM_LABEL_VALUE,
  VM_OWNER_LABEL,
  VM_VOLUME_PERSIST_ANNOTATION,
  VM_VOLUME_SLUG_ANNOTATION,
  VmAgentType,
  VmImageType,
  VmStatus,
} from "./vms.types"

// All VM/Volume/LB/Agent resources live in this single namespace.
// Ownership is enforced by FGA tuples + per-resource ownership checks
// in the service methods, not by namespace isolation. Switching from
// per-owner namespaces was deliberate so we can later share/transfer
// resources without moving k8s objects (which is impossible for PVCs
// and surprising for everything else).
export const RESOURCE_NS = "resource"

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
  constructor(
    private readonly fga: OpenFgaService,
    private readonly volumes: VolumesService,
    private readonly loadBalancers: LoadBalancersService,
    private readonly agents: AgentsService,
  ) {}

  private readonly imageBase = process.env.VM_IMAGE_BASE ?? ""
  private readonly imageDesktop = process.env.VM_IMAGE_DESKTOP ?? ""
  private readonly vmDomain = process.env.VM_DOMAIN ?? "vm.localhost"
  // oauth2-proxy public URL. Launch links route through
  // /oauth2/start?rd=<vm-url> so users get silent SSO via Keycloak
  // before landing on the VM hostname (forwardAuth on the VM URL
  // would otherwise return a blank 401 to a browser).
  private readonly oauthProxyUrl = process.env.OAUTH_PROXY_URL ?? ""
  // Gateway API parent ref for per-VM HTTPRoutes. Defaults match the
  // dev cluster's `platform-gateway` in `platform-traefik`.
  private readonly gatewayName =
    process.env.VM_GATEWAY_NAME ?? "platform-gateway"
  private readonly gatewayNamespace =
    process.env.VM_GATEWAY_NAMESPACE ?? "platform-traefik"
  // ForwardAuth chain: oauth2-proxy /oauth2/auth (session) →
  // console-api /vms/auth (FGA ownership). Traefik resolves
  // Middleware refs only within the HTTPRoute's namespace, so the
  // api clones tiny Middlewares into each VM namespace. Empty oauth
  // URL = no auth gate at all.
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

  // Admin-only: every VM in the resource namespace. Ownership labels
  // surface in the toVm output so admins can see who owns what.
  async listAll(): Promise<Vm[]> {
    const apps = k8sApps()
    const res = await apps.listNamespacedStatefulSet({
      namespace: RESOURCE_NS,
      labelSelector: `${VM_LABEL}=${VM_LABEL_VALUE}`,
    }).catch((err: { code?: number; statusCode?: number }) => {
      if ((err.code ?? err.statusCode) === 404) return { items: [] }
      throw err
    })
    return (res.items ?? []).map((sts) => this.toVm(sts))
  }

  // FGA-driven listing: ask FGA which VMs the user can access, then
  // batch-read those StatefulSets from the unified namespace. Stale
  // tuples (FGA says yes but k8s 404s) are silently dropped.
  async listForOwner(ownerId: string): Promise<Vm[]> {
    const slugs = await this.fga.listAccessibleVms(ownerId)
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
      .map((sts) => this.toVm(sts))
  }

  async create(ownerId: string, input: CreateVmInput): Promise<Vm> {
    const displayName = input.name.trim()
    if (!displayName) throw new BadRequestException("name is required")
    if (displayName.length > 200) {
      throw new BadRequestException("name must be 200 characters or fewer")
    }
    const slug = randomSlug()
    const ns = RESOURCE_NS
    const image = this.imageFor(input.imageType)
    const cpu = input.cpuRequest ?? VM_DEFAULTS.cpu
    const memory = input.memoryRequest ?? VM_DEFAULTS.memory

    // Stamp the FGA owner tuple BEFORE any k8s ops. If anything
    // downstream throws partway, the user can still see the VM in
    // /vms (when STS exists) and run delete to clean up. Granting
    // late is what produced "ghost" VMs we had to chase by hand.
    await this.fga.grantVmOwner(slug, ownerId).catch((err) => {
      throw new Error(
        `Failed to grant VM owner tuple for ${slug}: ${(err as Error).message}`,
      )
    })
    // Note: when an agent is attached, AgentsService.create (called
    // at the end of this method) writes its own `agent:<agent-slug>`
    // FGA tuple. The VM owner tuple here is independent.

    // Idempotent: ensures the unified namespace exists on first
    // create after a fresh deploy. Cheap on subsequent calls.
    await this.ensureNamespace(ns)

    // Resolve the data volume per requested mode. We don't use
    // StatefulSet volumeClaimTemplates anymore — every PVC is a
    // standalone Volume so it can outlive the VM (persist mode) or
    // be reattached to a different VM (attach mode).
    const persist = !!input.persistVolumeOnDelete && input.volumeMode === "new"
    let volumeSlug: string | null = null
    if (input.volumeMode === "new") {
      const created = await this.volumes.create(ownerId, {
        name: input.volumeName?.trim() || `${displayName} volume`,
        sizeGi: input.volumeSizeGi ?? VM_DEFAULTS.volumeSizeGi,
      })
      volumeSlug = created.slug
    } else if (input.volumeMode === "attach") {
      if (!input.volumeSlug) {
        throw new BadRequestException(
          "volumeSlug is required when volumeMode='attach'",
        )
      }
      const owned = await this.volumes.listForOwner(ownerId)
      const v = owned.find((x) => x.slug === input.volumeSlug)
      if (!v) throw new BadRequestException(`Volume "${input.volumeSlug}" not found.`)
      if (v.boundTo) {
        throw new ConflictException(
          `Volume "${v.slug}" is already bound to VM "${v.boundTo}".`,
        )
      }
      volumeSlug = v.slug
    }

    // Auth Middlewares live once in the unified namespace:
    //  1. oauth-auth → forwardAuth → oauth2-proxy /oauth2/auth (session)
    //  2. fga → forwardAuth → console-api /vms/auth (ownership)
    // (Direct-typed VM URLs without a session still get a blank 401 —
    // launch links from the console UI route through /oauth2/start to
    // give silent SSO instead.)
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

    // Agent attachment now lives in a SEPARATE pod (via
    // AgentsService.create with boundToVm). VM pod is back to just
    // workspace + dind. The only piece the VM still owns is the
    // SSH key Secret used by the agent — workspace's sshd needs
    // the matching authorized_keys mounted in.
    const wantAgent = input.agentType !== "none"

    await this.ensureService(ns, slug, input.imageType)

    // Per-VM ServiceAccount so kubectl-from-the-VM has its own
    // identity (not the namespace's default SA, which has nothing).
    // Always-on RoleBinding gives `admin` inside `resource` ns;
    // opt-in ClusterRoleBinding adds cluster-wide cluster-admin for
    // `terraform apply` / cross-namespace work. Both are
    // cascade-deleted in delete().
    await this.ensureVmServiceAccount(ns, slug, ownerId, !!input.clusterAdmin)

    let sshKeySecretName: string | null = null
    if (wantAgent) {
      if (!input.agentType) {
        throw new BadRequestException("agentType is required for sidecar agent.")
      }
      // Pre-create the SSH key Secret BEFORE the workspace pod —
      // pod template references it by name, so it has to exist.
      // The agent pod (created later via AgentsService) reads the
      // private key from the same Secret.
      sshKeySecretName = `agent-ssh-${slug}`
      const { privateKeyPem, publicKeyOpenssh } = generateAgentKeypair(
        `agent-${slug}`,
      )
      const core = k8sCore()
      await core.createNamespacedSecret({
        namespace: ns,
        body: {
          apiVersion: "v1",
          kind: "Secret",
          metadata: {
            name: sshKeySecretName,
            namespace: ns,
            labels: {
              [VM_LABEL]: VM_LABEL_VALUE,
              [VM_OWNER_LABEL]: sanitizeLabel(ownerId),
              "agent-platform/agent-bound-to-vm": slug,
            },
          },
          type: "Opaque",
          stringData: {
            id_ed25519: privateKeyPem,
            authorized_keys: publicKeyOpenssh + "\n",
          },
        },
      }).catch((err) => rethrowK8sError(err, `Failed to create SSH Secret for ${slug}`))
    }

    const workspaceMounts: Array<{
      name: string
      mountPath: string
      subPath?: string
      readOnly?: boolean
    }> = []
    if (volumeSlug) {
      workspaceMounts.push({
        name: VM_DATA_VOLUME_NAME,
        mountPath: VM_DATA_MOUNT_PATH,
      })
    }
    if (sshKeySecretName) {
      workspaceMounts.push({
        name: "agent-ssh",
        mountPath: "/etc/agent-ssh",
        readOnly: true,
      })
    }

    const containers: Array<Record<string, unknown>> = [
      {
        name: "vm",
        image,
        ports: [
          { name: "http", containerPort: 8080 },
          { name: "xterm", containerPort: 7681 },
          { name: "webui", containerPort: 8787 },
          ...(input.imageType === "desktop"
            ? [{ name: "vnc", containerPort: 6901 }]
            : []),
          ...(wantAgent ? [{ name: "ssh", containerPort: 22 }] : []),
        ],
        env: [
          { name: "VM_OWNER", value: ownerId },
          { name: "VM_SLUG", value: slug },
          { name: "VM_NAME", value: displayName },
          { name: "VM_AGENT", value: input.agentType },
          { name: "DOCKER_HOST", value: "tcp://127.0.0.1:2375" },
        ],
        volumeMounts: workspaceMounts,
        resources: {
          requests: { cpu, memory },
          limits: { cpu, memory },
        },
      },
      {
        name: "dind",
        image: "docker:24-dind",
        args: ["--mtu=1450"],
        env: [{ name: "DOCKER_TLS_CERTDIR", value: "" }],
        securityContext: { privileged: true, runAsUser: 0 },
        // /var/lib/docker on emptyDir — image cache + running
        // containers don't survive pod restart, but the workspace
        // PVC stays clean (no root-owned `docker/` subdir
        // surfacing in /home/coder/workspace, no permission errors
        // for the coder user).
        volumeMounts: [
          { name: "dind-state", mountPath: "/var/lib/docker" },
        ],
      },
    ]

    const podVolumes: Array<Record<string, unknown>> = [
      // Per-pod docker daemon state. Always emptyDir; see the dind
      // container's volumeMount comment for the rationale.
      { name: "dind-state", emptyDir: {} },
    ]
    if (volumeSlug) {
      podVolumes.push({
        name: VM_DATA_VOLUME_NAME,
        persistentVolumeClaim: { claimName: volumeSlug },
      })
    }
    if (sshKeySecretName) {
      podVolumes.push({
        name: "agent-ssh",
        secret: {
          secretName: sshKeySecretName,
          items: [{ key: "authorized_keys", path: "authorized_keys" }],
        },
      })
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
            labels: this.vmLabels(ownerId, input.imageType, input.agentType),
            annotations: {
              [VM_DISPLAY_NAME_ANNOTATION]: displayName,
              ...(volumeSlug ? { [VM_VOLUME_SLUG_ANNOTATION]: volumeSlug } : {}),
              [VM_VOLUME_PERSIST_ANNOTATION]: persist ? "true" : "false",
            },
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
              spec: ({
                serviceAccountName: slug,
                containers,
                volumes: podVolumes,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } as unknown as any),
            },
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

    // Stamp the bound-to label on the volume so /volumes shows it
    // as bound (and the "attach" picker filters it out).
    if (volumeSlug) {
      await this.volumes.bindToVm(ownerId, volumeSlug, slug)
    }

    // Per-host HTTPRoutes — one hostname per service.
    await this.ensureHttpRoute(ns, slug, "term", 7681)
    await this.ensureHttpRoute(ns, slug, "code", 8080)
    if (input.imageType === "desktop") {
      await this.ensureHttpRoute(ns, slug, "vnc", 6901)
    }

    // Optional convenience LBs attached at create time. One create
    // per entry, sequential so 409s don't overlap. Failure throws —
    // the VM is already up at this point but the caller should know
    // the LB step partially failed.
    for (const lb of input.loadBalancers ?? []) {
      if (!Number.isInteger(lb.port) || lb.port < 1 || lb.port > 65535) {
        throw new BadRequestException(
          `loadBalancer port must be an integer 1-65535 (got ${lb.port})`,
        )
      }
      await this.loadBalancers.create(ownerId, {
        name: lb.name?.trim() || `${displayName} :${lb.port}`,
        vmSlug: slug,
        port: lb.port,
      })
    }

    // Attached agent — runs in its own pod with podAffinity to this
    // VM's node, mounts the workspace PVC at /home/coder/workspace,
    // bash-shims into the workspace's sshd. Lifecycle is bound to
    // this VM (cascade-deleted in vms.service.delete).
    if (wantAgent && volumeSlug && sshKeySecretName) {
      await this.agents.create(ownerId, {
        name: `${displayName} agent`,
        agentType: input.agentType as Exclude<typeof input.agentType, "none">,
        boundToVm: slug,
        workspaceVolumeSlug: volumeSlug,
        sshKeySecretName,
        model: input.agentModel,
      })
    } else if (wantAgent) {
      throw new BadRequestException(
        "Agent attachment requires a volume — pick `Create new` or `Attach existing` rather than `No volume`.",
      )
    }

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
    // FGA gate: refuse to act on a VM the caller doesn't own. 404
    // (not 403) so we don't leak existence to non-owners.
    const allowed = await this.fga.canAccessVm(ownerId, cleanSlug)
    if (!allowed) throw new NotFoundException(`VM "${cleanSlug}" not found.`)
    const ns = RESOURCE_NS
    const apps = k8sApps()
    const core = k8sCore()

    // Read the StatefulSet's annotations BEFORE we delete it — they
    // tell us whether the bound volume should be persisted or
    // cleaned up. Reading after delete would race the K8s GC.
    let boundVolume: string | null = null
    let persistVolume = false
    try {
      const sts = await apps.readNamespacedStatefulSet({
        name: cleanSlug,
        namespace: ns,
      })
      const annotations = sts.metadata?.annotations ?? {}
      boundVolume = annotations[VM_VOLUME_SLUG_ANNOTATION] ?? null
      persistVolume = annotations[VM_VOLUME_PERSIST_ANNOTATION] === "true"
    } catch {
      // 404 / other → fall through, no volume bookkeeping needed.
    }

    await apps
      .deleteNamespacedStatefulSet({ name: cleanSlug, namespace: ns })
      .catch((err: { code?: number; statusCode?: number }) => {
        if ((err.code ?? err.statusCode) === 404) return
        throw err
      })
    await core
      .deleteNamespacedService({ name: cleanSlug, namespace: ns })
      .catch(() => undefined)

    // Volume cleanup: persist=true → unbind only (the volume shows
    // up under /volumes for re-attach). persist=false → unbind THEN
    // delete (volumes.delete refuses to delete a volume with a
    // bound-to label, so unbind has to come first). volumeMode=none
    // → no volume, nothing to do.
    if (boundVolume) {
      await this.volumes.unbindFromVm(ownerId, boundVolume).catch(() => undefined)
      if (!persistVolume) {
        await this.volumes.delete(ownerId, boundVolume).catch(() => undefined)
      }
    }
    // Cascade-delete every Agent attached to this VM. Each one is
    // its own StatefulSet+Service+HTTPRoute now — AgentsService
    // owns the teardown + revoke its FGA tuple.
    const attached = await this.agents.listForVm(cleanSlug).catch(() => [])
    for (const a of attached) {
      await this.agents.deleteAttachedForCascade(a.slug).catch(() => undefined)
    }
    // SSH key Secret. Lifecycle is the VM's, not the agent's, since
    // it's mounted by both VM workspace (authorized_keys) and the
    // agent pod (private key) — created at VM-create time.
    await core
      .deleteNamespacedSecret({ name: `agent-ssh-${cleanSlug}`, namespace: ns })
      .catch(() => undefined)
    // Per-VM ServiceAccount + (Cluster)RoleBinding teardown — created
    // by ensureVmServiceAccount at VM-create time. Cluster binding may
    // not exist (only made when clusterAdmin was opted in); both
    // deletes swallow 404 so cleanup is idempotent.
    await this.deleteVmServiceAccount(ns, cleanSlug)
    // LB cleanup: cascade-delete every LB targeting this VM.
    await this.loadBalancers.cascadeDeleteForVm(ownerId, cleanSlug)
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

  // Create the per-VM ServiceAccount + RoleBinding (always) and
  // ClusterRoleBinding (opt-in). Pod spec sets serviceAccountName=slug
  // so kubelet projects this SA's token; agent-sandbox's start.sh
  // turns that token into ~/.kube/config so kubectl Just Works in the
  // VM. ConflictException is swallowed so re-running create after a
  // partial failure is idempotent.
  private async ensureVmServiceAccount(
    ns: string,
    slug: string,
    ownerId: string,
    clusterAdmin: boolean,
  ): Promise<void> {
    const labels = {
      [VM_LABEL]: VM_LABEL_VALUE,
      [VM_OWNER_LABEL]: sanitizeLabel(ownerId),
      "agent-platform/vm-slug": slug,
    }
    const core = k8sCore()
    const rbac = k8sRbac()
    const swallow409 = (err: { code?: number; statusCode?: number }) => {
      if ((err.code ?? err.statusCode) === 409) return
      throw err
    }
    await core
      .createNamespacedServiceAccount({
        namespace: ns,
        body: {
          apiVersion: "v1",
          kind: "ServiceAccount",
          metadata: { name: slug, namespace: ns, labels },
        },
      })
      .catch(swallow409)
    // Namespace-scoped admin so the user can manage their own VMs /
    // agents / LBs / volumes via kubectl. `admin` ClusterRole is the
    // canonical "do anything in this namespace" role.
    await rbac
      .createNamespacedRoleBinding({
        namespace: ns,
        body: {
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "RoleBinding",
          metadata: { name: slug, namespace: ns, labels },
          subjects: [{ kind: "ServiceAccount", name: slug, namespace: ns }],
          roleRef: {
            apiGroup: "rbac.authorization.k8s.io",
            kind: "ClusterRole",
            name: "admin",
          },
        },
      })
      .catch(swallow409)
    if (clusterAdmin) {
      // Cluster-wide cluster-admin. Lives outside any namespace, so
      // we encode the VM identity in the binding name (vm-<slug>) for
      // cleanup. Same labels make orphan-finding easy.
      await rbac
        .createClusterRoleBinding({
          body: {
            apiVersion: "rbac.authorization.k8s.io/v1",
            kind: "ClusterRoleBinding",
            metadata: { name: `vm-${slug}`, labels },
            subjects: [
              { kind: "ServiceAccount", name: slug, namespace: ns },
            ],
            roleRef: {
              apiGroup: "rbac.authorization.k8s.io",
              kind: "ClusterRole",
              name: "cluster-admin",
            },
          },
        })
        .catch(swallow409)
    }
  }

  // Counterpart to ensureVmServiceAccount — runs in delete(). Each
  // delete is best-effort; missing resources (e.g. ClusterRoleBinding
  // when clusterAdmin was off) just no-op.
  private async deleteVmServiceAccount(ns: string, slug: string): Promise<void> {
    const core = k8sCore()
    const rbac = k8sRbac()
    await rbac
      .deleteClusterRoleBinding({ name: `vm-${slug}` })
      .catch(() => undefined)
    await rbac
      .deleteNamespacedRoleBinding({ name: slug, namespace: ns })
      .catch(() => undefined)
    await core
      .deleteNamespacedServiceAccount({ name: slug, namespace: ns })
      .catch(() => undefined)
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
    // ExtensionRef chain: oauth (sets X-Auth-Request-* headers) →
    // fga (consumes those headers).
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
      body: {
        metadata: {
          name: ns,
          labels: { [VM_LABEL]: "resource-namespace" },
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

  // Wraps a VM URL in oauth2-proxy /oauth2/start?rd=… so the browser
  // gets a redirect chain: Keycloak (silent) → oauth2-proxy callback
  // → VM URL. When OAUTH_PROXY_URL is unset, returns the URL unchanged.
  private launchUrl(target: string): string {
    if (!this.oauthProxyUrl) return target
    return `${this.oauthProxyUrl}/oauth2/start?rd=${encodeURIComponent(target)}`
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
      // Per-host URLs under the `*.vm.<domain>` wildcard listener.
      // Routed through oauth2-proxy /oauth2/start so the browser does
      // a silent OIDC roundtrip first (user already has a Keycloak
      // session from console login), then lands on the VM hostname
      // with a valid `_oauth2_proxy` cookie on `.<domain>`.
      // Browsers need the platform root CA trusted once
      // (sudo security add-trusted-cert ...).
      xtermUrl: this.launchUrl(`https://${slug}-term.${this.vmDomain}`),
      codeUrl: this.launchUrl(`https://${slug}-code.${this.vmDomain}`),
      vncUrl:
        imageType === "desktop"
          ? this.launchUrl(`https://${slug}-vnc.${this.vmDomain}`)
          : null,
    }
  }
}
