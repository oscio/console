import { randomBytes } from "node:crypto"
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { OpenFgaService } from "../openfga/openfga.service"
import { k8sCore, k8sCustom } from "../vms/k8s.client"
import { RESOURCE_NS } from "../vms/vms.service"
import {
  CreateLoadBalancerInput,
  LoadBalancer,
  LoadBalancerStatus,
  LB_DISPLAY_NAME_ANNOTATION,
  LB_LABEL,
  LB_LABEL_VALUE,
  LB_OWNER_LABEL,
  LB_PERSIST_ON_VM_DELETE_ANNOTATION,
  LB_PORT_ANNOTATION,
  LB_VM_LABEL,
} from "./loadbalancers.types"

function sanitizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
}

function randomSlug(): string {
  return `lb-${randomBytes(4).toString("hex")}`
}

function rethrowK8sError(err: unknown, fallback: string): never {
  const e = err as { code?: number; statusCode?: number; body?: unknown }
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
export class LoadBalancersService {
  private readonly vmDomain = process.env.VM_DOMAIN ?? "vm.localhost"
  private readonly lbDomain =
    process.env.LB_DOMAIN ??
    // Derive from vmDomain by swapping `vm.` → `lb.`. Same parent
    // domain so the platform CA / browser trust covers both.
    this.vmDomain.replace(/^vm\./, "lb.")
  private readonly gatewayName =
    process.env.VM_GATEWAY_NAME ?? "platform-gateway"
  private readonly gatewayNamespace =
    process.env.VM_GATEWAY_NAMESPACE ?? "platform-traefik"

  constructor(private readonly fga: OpenFgaService) {}

  async listForOwner(ownerId: string): Promise<LoadBalancer[]> {
    const slugs = await this.fga.listAccessibleLoadBalancers(ownerId)
    if (slugs.length === 0) return []
    const custom = k8sCustom()
    const ns = RESOURCE_NS
    const items = await Promise.all(
      slugs.map((slug) =>
        custom
          .getNamespacedCustomObject({
            group: "gateway.networking.k8s.io",
            version: "v1",
            namespace: ns,
            plural: "httproutes",
            name: slug,
          })
          .catch(() => null),
      ),
    )
    const present = items.filter(
      (r): r is HttpRouteShape => r !== null,
    )
    if (present.length === 0) return []
    const endpoints = await this.endpointMap(ns).catch(
      () => new Map<string, boolean>(),
    )
    return present.map((r) => this.toLb(r, endpoints))
  }

  async create(
    ownerId: string,
    input: CreateLoadBalancerInput,
  ): Promise<LoadBalancer> {
    const displayName = input.name.trim()
    if (!displayName) throw new BadRequestException("name is required")
    if (!input.vmSlug || !sanitizeLabel(input.vmSlug)) {
      throw new BadRequestException("vmSlug is required")
    }
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
      throw new BadRequestException("port must be an integer 1-65535")
    }
    const vmSlug = sanitizeLabel(input.vmSlug)
    // FGA gate: caller must own the target VM. Without this check the
    // unified namespace would let any logged-in user point an LB at
    // anyone else's VM.
    const allowed = await this.fga.canAccessVm(ownerId, vmSlug)
    if (!allowed) {
      throw new NotFoundException(`VM "${vmSlug}" not found.`)
    }
    const slug = randomSlug()
    const ns = RESOURCE_NS

    // Service: ClusterIP, selects the VM pod by vm-slug label.
    const core = k8sCore()
    try {
      await core.createNamespacedService({
        namespace: ns,
        body: {
          apiVersion: "v1",
          kind: "Service",
          metadata: {
            name: slug,
            namespace: ns,
            labels: {
              [LB_LABEL]: LB_LABEL_VALUE,
              [LB_OWNER_LABEL]: sanitizeLabel(ownerId),
              [LB_VM_LABEL]: vmSlug,
            },
            annotations: {
              [LB_PORT_ANNOTATION]: String(input.port),
              [LB_DISPLAY_NAME_ANNOTATION]: displayName,
              [LB_PERSIST_ON_VM_DELETE_ANNOTATION]:
                input.persistOnVmDelete ? "true" : "false",
            },
          },
          spec: {
            selector: { "agent-platform/vm-slug": vmSlug },
            ports: [
              { name: "lb", port: input.port, targetPort: input.port },
            ],
          },
        },
      })
    } catch (err: unknown) {
      const code = (err as { code?: number; statusCode?: number }).code
        ?? (err as { statusCode?: number }).statusCode
      if (code === 409) {
        throw new ConflictException(`LoadBalancer "${slug}" already exists.`)
      }
      rethrowK8sError(err, `Failed to create Service for "${slug}"`)
    }

    // HTTPRoute on `*.lb.<domain>` listener → the per-LB Service.
    const hostname = `${slug}.${this.lbDomain}`
    try {
      await k8sCustom().createNamespacedCustomObject({
        group: "gateway.networking.k8s.io",
        version: "v1",
        namespace: ns,
        plural: "httproutes",
        body: {
          apiVersion: "gateway.networking.k8s.io/v1",
          kind: "HTTPRoute",
          metadata: {
            name: slug,
            namespace: ns,
            labels: {
              [LB_LABEL]: LB_LABEL_VALUE,
              [LB_OWNER_LABEL]: sanitizeLabel(ownerId),
              [LB_VM_LABEL]: vmSlug,
            },
            annotations: {
              [LB_PORT_ANNOTATION]: String(input.port),
              [LB_DISPLAY_NAME_ANNOTATION]: displayName,
              [LB_PERSIST_ON_VM_DELETE_ANNOTATION]:
                input.persistOnVmDelete ? "true" : "false",
            },
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
                backendRefs: [
                  { group: "", kind: "Service", name: slug, port: input.port },
                ],
              },
            ],
          },
        },
      })
    } catch (err) {
      // Roll back the Service so we don't leak an orphan.
      await core
        .deleteNamespacedService({ name: slug, namespace: ns })
        .catch(() => undefined)
      rethrowK8sError(err, `Failed to create HTTPRoute for "${slug}"`)
    }

    await this.fga.grantLoadBalancerOwner(slug, ownerId).catch(() => undefined)

    const list = await this.listForOwner(ownerId)
    const created = list.find((x) => x.slug === slug)
    if (!created) throw new NotFoundException("LoadBalancer created but not found.")
    return created
  }

  async delete(ownerId: string, slug: string): Promise<void> {
    const cleanSlug = sanitizeLabel(slug)
    if (!cleanSlug) throw new BadRequestException("Invalid LB slug.")
    const allowed = await this.fga.canAccessLoadBalancer(ownerId, cleanSlug)
    if (!allowed) {
      throw new NotFoundException(`LoadBalancer "${cleanSlug}" not found.`)
    }
    const ns = RESOURCE_NS
    const core = k8sCore()
    const custom = k8sCustom()
    await custom
      .deleteNamespacedCustomObject({
        group: "gateway.networking.k8s.io",
        version: "v1",
        namespace: ns,
        plural: "httproutes",
        name: cleanSlug,
      })
      .catch(() => undefined)
    await core
      .deleteNamespacedService({ name: cleanSlug, namespace: ns })
      .catch(() => undefined)
    const owners = await this.fga
      .listLoadBalancerOwners(cleanSlug)
      .catch(() => [])
    for (const u of owners) {
      await this.fga.revokeLoadBalancerOwner(cleanSlug, u).catch(() => undefined)
    }
  }

  // Called from vms.service.delete: removes every LB targeting the
  // VM that wasn't created with the "persist on VM delete" flag.
  // Returns the list of LBs the caller may want to surface as
  // "kept" (persisted ones outlive the VM and become broken until
  // re-pointed; we leave them visible under /loadbalancers).
  async cascadeDeleteForVm(ownerId: string, vmSlug: string): Promise<void> {
    const ns = RESOURCE_NS
    const custom = k8sCustom()
    const res = (await custom
      .listNamespacedCustomObject({
        group: "gateway.networking.k8s.io",
        version: "v1",
        namespace: ns,
        plural: "httproutes",
        labelSelector: `${LB_LABEL}=${LB_LABEL_VALUE},${LB_VM_LABEL}=${sanitizeLabel(vmSlug)}`,
      })
      .catch(() => ({ items: [] }))) as { items?: HttpRouteShape[] }
    for (const r of res.items ?? []) {
      const persist =
        r.metadata?.annotations?.[LB_PERSIST_ON_VM_DELETE_ANNOTATION] === "true"
      if (persist) continue
      const slug = r.metadata?.name
      if (!slug) continue
      await this.delete(ownerId, slug).catch(() => undefined)
    }
  }

  // Build a `<lb-slug> → has endpoints?` map by reading the
  // EndpointSlices in the namespace. Avoids per-row reads.
  private async endpointMap(ns: string): Promise<Map<string, boolean>> {
    const custom = k8sCustom()
    type Slice = {
      metadata?: { labels?: Record<string, string> }
      endpoints?: Array<{ conditions?: { ready?: boolean } }>
    }
    const res = (await custom.listNamespacedCustomObject({
      group: "discovery.k8s.io",
      version: "v1",
      namespace: ns,
      plural: "endpointslices",
    })) as { items?: Slice[] }
    const map = new Map<string, boolean>()
    for (const slice of res.items ?? []) {
      const svcName = slice.metadata?.labels?.["kubernetes.io/service-name"]
      if (!svcName) continue
      // Per the EndpointSlice spec, `conditions.ready` is `treat as
      // ready when absent`. Strict `=== true` left healthy LBs stuck
      // on Pending whenever kubelet/EndpointSlice controller didn't
      // bother stamping the field. Accept "anything not explicitly
      // false" as ready.
      const ready = (slice.endpoints ?? []).some(
        (e) => e.conditions?.ready !== false,
      )
      if (ready) map.set(svcName, true)
    }
    return map
  }

  private toLb(
    route: HttpRouteShape,
    endpoints: Map<string, boolean>,
  ): LoadBalancer {
    const slug = route.metadata?.name ?? "unknown"
    const namespace = route.metadata?.namespace ?? "unknown"
    const labels = route.metadata?.labels ?? {}
    const annotations = route.metadata?.annotations ?? {}
    const owner = labels[LB_OWNER_LABEL] ?? "unknown"
    const vmSlug = labels[LB_VM_LABEL] ?? "unknown"
    const port = Number(annotations[LB_PORT_ANNOTATION] ?? "0")
    const displayName = annotations[LB_DISPLAY_NAME_ANNOTATION] ?? slug
    const hostname = route.spec?.hostnames?.[0] ?? `${slug}.${this.lbDomain}`
    const ts = route.metadata?.creationTimestamp
    const createdAt =
      ts instanceof Date ? ts.toISOString() : (ts ?? new Date().toISOString())
    const status: LoadBalancerStatus = endpoints.get(slug) ? "Ready" : "Pending"
    return {
      id: route.metadata?.uid ?? `${namespace}/${slug}`,
      slug,
      name: displayName,
      owner,
      namespace,
      vmSlug,
      port,
      hostname,
      url: `https://${hostname}`,
      status,
      createdAt,
    }
  }
}

type HttpRouteShape = {
  metadata?: {
    name?: string
    namespace?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    uid?: string
    creationTimestamp?: string | Date
  }
  spec?: { hostnames?: string[] }
}
