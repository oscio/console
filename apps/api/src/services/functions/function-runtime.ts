import { Logger } from "@nestjs/common"
import * as http from "node:http"
import { k8sCore, k8sCustom } from "../../vms/k8s.client"
import { RESOURCE_NS } from "../../vms/vms.service"

const FUNCTION_LABEL = "agent-platform/component"
const FUNCTION_LABEL_VALUE = "function"
const FUNCTION_SLUG_LABEL = "agent-platform/function-slug"

// Image used by every function's dev Knative Service. Single-binary
// runtime (starlette + uvicorn + the runner main.py); user code
// arrives via ConfigMap mount, so iterating doesn't require a build.
function devImage(): string {
  const v = process.env.FUNCTION_DEV_IMAGE
  if (!v) {
    throw new Error("FUNCTION_DEV_IMAGE env var is required")
  }
  return v
}

// Domain Knative auto-generates Service URLs under, supplied by tf
// (config-domain entry). Required — there's no sensible default that
// would happen to match a fresh cluster's setup.
function functionDomain(): string {
  const v = process.env.FUNCTION_DOMAIN
  if (!v) {
    throw new Error("FUNCTION_DOMAIN env var is required")
  }
  return v
}

// Image registry prefix the Deploy flow patches Knative Services
// onto. Each function gets its own image (built by Forgejo Actions
// from the function repo) under this prefix.
function functionImagePrefix(): string {
  const v = process.env.FUNCTION_IMAGE_PREFIX
  if (!v) {
    throw new Error("FUNCTION_IMAGE_PREFIX env var is required")
  }
  return v.replace(/\/$/, "")
}

export function productionImageRef(slug: string, sha: string): string {
  return `${functionImagePrefix()}/${slug}:${sha}`
}

// Last `:tag` segment of an image ref (handles `host:port/img:sha`
// vs `img:sha`). Used to surface the deployed git SHA via env so the
// user's handler can identify its own version.
function extractTag(image: string): string {
  const colon = image.lastIndexOf(":")
  if (colon === -1) return ""
  // If the colon is inside a `host:port` (no slash after it), there's
  // no tag — treat as untagged.
  if (image.indexOf("/", colon) !== -1) return ""
  return image.slice(colon + 1)
}

// The hostname Traefik routes to, regardless of whether the function
// is currently exposed. Mirrors what Knative's domainTemplate is
// configured to emit so HTTPRoute hostname and Kourier's expected
// Host header line up.
export function functionHostname(slug: string): string {
  return `${slug}.${functionDomain()}`
}

// Public-URL builder. Only meaningful when `exposed` is on; the UI
// hides the value when off but the helper still returns a stable
// string so callers don't have to special-case empty.
export function exposedUrl(slug: string): string {
  return `https://${functionHostname(slug)}`
}

// Cluster-internal Kourier endpoint console-api proxies through. The
// in-cluster DNS doesn't depend on the platform domain, so we keep
// a fallback to the Knative-default service name.
function kourierUrl(): string {
  return (
    process.env.FUNCTION_INVOKE_TARGET ??
    "http://kourier.kourier-system.svc.cluster.local"
  )
}

const log = new Logger("FunctionRuntime")

export function configMapName(slug: string): string {
  return `function-code-${slug}`
}

// Two Knative Services per function. `<slug>` is the production
// surface (built image, baked-in code, the URL users actually call);
// `<slug>-dev` is the editor preview (dev image + ConfigMap-mounted
// code, scale-to-zero like prod). Splitting them means Save can roll
// dev fast without disturbing prod, and Deploy promotes only when
// the user is ready.
export function prodServiceName(slug: string): string {
  return slug
}

export function devServiceName(slug: string): string {
  return `${slug}-dev`
}

// ----- ConfigMap -----------------------------------------------------------

// Push the user's function/* files into a ConfigMap that the dev pod
// mounts at /app/function/. Idempotent: replaces the data block on
// every call. The ConfigMap path layout matches what the dev runner
// expects to see at /app/function/.
export async function syncFunctionCodeConfigMap(
  slug: string,
  files: { path: string; content: string }[],
  userFolder: string,
): Promise<void> {
  const core = k8sCore()
  const name = configMapName(slug)

  // Strip the userFolder prefix so files land at /app/function/<rel>
  // when ConfigMap is mounted at /app/function. ConfigMap data keys
  // can't contain `/`, so for nested paths we encode with `__` —
  // matches the projection trick volumes.subPath uses elsewhere.
  // Phase-2 doesn't actually allow nested user files yet, so this is
  // forward-compat and most maps will be flat.
  const data: Record<string, string> = {}
  for (const f of files) {
    if (!f.path.startsWith(userFolder + "/")) continue
    const rel = f.path.slice(userFolder.length + 1)
    if (rel.includes("/")) {
      // ConfigMap key can't have slashes; flatten with `__` for now.
      // (We won't surface nested routes until the runner handles
      // matching __-encoded paths.)
      data[rel.replace(/\//g, "__")] = f.content
    } else {
      data[rel] = f.content
    }
  }

  const body = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name,
      namespace: RESOURCE_NS,
      labels: {
        [FUNCTION_LABEL]: FUNCTION_LABEL_VALUE,
        [FUNCTION_SLUG_LABEL]: slug,
      },
    },
    data,
  }

  try {
    await core.replaceNamespacedConfigMap({
      name,
      namespace: RESOURCE_NS,
      body,
    })
  } catch (err) {
    if (isNotFound(err)) {
      await core.createNamespacedConfigMap({ namespace: RESOURCE_NS, body })
    } else {
      throw err
    }
  }
}

export async function deleteFunctionCodeConfigMap(slug: string): Promise<void> {
  const core = k8sCore()
  await core
    .deleteNamespacedConfigMap({
      name: configMapName(slug),
      namespace: RESOURCE_NS,
    })
    .catch((err) => {
      if (!isNotFound(err)) {
        log.warn(`deleteConfigMap ${slug}: ${(err as Error).message}`)
      }
    })
}

// ----- Knative Service -----------------------------------------------------

// Update strategy is GET → modify-spec → replace (PUT). Knative's
// admission webhook treats annotations like
// `metadata.annotations.serving.knative.dev/creator` as immutable,
// so a wholesale replace with a freshly-built body is rejected.
// Keep the existing object as the base, swap only `spec` and the
// bits of `metadata.labels` we own, and PUT.
//
// (Patch with an object body would be cleaner but the
// @kubernetes/client-node v1 typed client defaults to
// application/json-patch+json content type, which expects a JSON
// Patch array.)
async function ensureService(name: string, desired: KnativeServiceBody): Promise<void> {
  const custom = k8sCustom()

  type KsvcShape = {
    metadata?: {
      resourceVersion?: string
      labels?: Record<string, string>
      annotations?: Record<string, string>
    }
    spec?: unknown
  }
  let existing: KsvcShape | null = null
  try {
    existing = (await custom.getNamespacedCustomObject({
      group: "serving.knative.dev",
      version: "v1",
      namespace: RESOURCE_NS,
      plural: "services",
      name,
    })) as KsvcShape
  } catch (err) {
    if (!isNotFound(err)) throw err
  }

  if (existing) {
    const merged = {
      ...existing,
      metadata: {
        ...existing.metadata,
        labels: {
          ...(existing.metadata?.labels ?? {}),
          ...desired.metadata.labels,
        },
      },
      spec: desired.spec,
    }
    await custom.replaceNamespacedCustomObject({
      group: "serving.knative.dev",
      version: "v1",
      namespace: RESOURCE_NS,
      plural: "services",
      name,
      body: merged,
    })
  } else {
    await custom.createNamespacedCustomObject({
      group: "serving.knative.dev",
      version: "v1",
      namespace: RESOURCE_NS,
      plural: "services",
      body: desired,
    })
  }
}

// Save flow: update the dev Service (dev image + ConfigMap mount).
// Production Service is left untouched — Save and Deploy are now
// independent surfaces.
export async function ensureDevService(slug: string): Promise<void> {
  const name = devServiceName(slug)
  const cm = configMapName(slug)
  await ensureService(
    name,
    buildKnativeServiceBody({ name, slug, mode: "dev", configMap: cm }),
  )
}

type KnativeServiceBody = {
  apiVersion: string
  kind: string
  metadata: {
    name: string
    namespace: string
    labels: Record<string, string>
    resourceVersion?: string
  }
  spec: unknown
}

const FUNCTION_MODE_LABEL = "agent-platform/function-mode"

function buildKnativeServiceBody(input: {
  name: string
  slug: string
  mode: "dev" | "prod"
  configMap?: string
  image?: string
}): KnativeServiceBody {
  const useConfigMap = input.mode === "dev"
  const image = input.image ?? devImage()
  const annotations: Record<string, string> = {
    "agent-platform/code-version": String(Date.now()),
    "agent-platform/mode": input.mode,
  }
  // Lambda-style runtime metadata for the user's `handler(event,
  // context)`. Read from env at runner cold-start; the handler sees
  // them via the second argument (e.g. context["function_name"]).
  // function_uri is the function's would-be public URL — always
  // populated, but only resolves externally when Exposed.
  const env = [
    { name: "OS_FUNCTION_NAME", value: input.slug },
    { name: "OS_FUNCTION_TARGET", value: input.mode },
    { name: "OS_FUNCTION_NAMESPACE", value: RESOURCE_NS },
    { name: "OS_FUNCTION_URI", value: exposedUrl(input.slug) },
    {
      name: "OS_FUNCTION_VERSION",
      // Prod is pinned to a built image:<sha>; dev floats on the
      // shared dev image so the SHA isn't meaningful there.
      value: input.mode === "prod" ? extractTag(image) : "dev",
    },
  ]
  const container: Record<string, unknown> = {
    image,
    ports: [{ containerPort: 8080 }],
    env,
  }
  const volumes: unknown[] = []
  if (useConfigMap && input.configMap) {
    container.volumeMounts = [{ name: "code", mountPath: "/app/function" }]
    volumes.push({ name: "code", configMap: { name: input.configMap } })
  }
  return {
    apiVersion: "serving.knative.dev/v1",
    kind: "Service",
    metadata: {
      name: input.name,
      namespace: RESOURCE_NS,
      labels: {
        [FUNCTION_LABEL]: FUNCTION_LABEL_VALUE,
        [FUNCTION_SLUG_LABEL]: input.slug,
        [FUNCTION_MODE_LABEL]: input.mode,
      },
    },
    spec: {
      template: {
        metadata: { annotations },
        spec: {
          containers: [container],
          ...(volumes.length > 0 ? { volumes } : {}),
        },
      },
    },
  }
}

// Deploy flow: stand up (or update) the prod Knative Service with
// the function-specific built image. Doesn't touch the dev Service —
// dev keeps tracking the latest Save independently.
export async function setProductionImage(
  slug: string,
  imageRef: string,
): Promise<void> {
  const name = prodServiceName(slug)
  await ensureService(
    name,
    buildKnativeServiceBody({ name, slug, mode: "prod", image: imageRef }),
  )
}

type ServiceState = {
  exists: boolean
  image: string | null
}

async function readServiceState(name: string): Promise<ServiceState> {
  const custom = k8sCustom()
  try {
    const res = (await custom.getNamespacedCustomObject({
      group: "serving.knative.dev",
      version: "v1",
      namespace: RESOURCE_NS,
      plural: "services",
      name,
    })) as {
      spec?: {
        template?: { spec?: { containers?: Array<{ image?: string }> } }
      }
    }
    const image = res.spec?.template?.spec?.containers?.[0]?.image ?? null
    return { exists: true, image }
  } catch (err) {
    if (isNotFound(err)) return { exists: false, image: null }
    throw err
  }
}

// Read both Service states. UI uses this to label which surfaces
// exist + which image prod is pinned to.
export async function getRuntimeMode(slug: string): Promise<{
  dev: { exists: boolean; image: string | null }
  prod: { exists: boolean; image: string | null }
}> {
  const [dev, prod] = await Promise.all([
    readServiceState(devServiceName(slug)),
    readServiceState(prodServiceName(slug)),
  ])
  return { dev, prod }
}

export async function deleteKnativeService(slug: string): Promise<void> {
  const custom = k8sCustom()
  for (const name of [devServiceName(slug), prodServiceName(slug)]) {
    await custom
      .deleteNamespacedCustomObject({
        group: "serving.knative.dev",
        version: "v1",
        namespace: RESOURCE_NS,
        plural: "services",
        name,
      })
      .catch((err) => {
        if (!isNotFound(err)) {
          log.warn(`deleteKnativeService ${name}: ${(err as Error).message}`)
        }
      })
  }
}

// ----- Public expose: HTTPRoute --------------------------------------------

// Hostname Traefik should match for the function's public URL. With
// Knative's domainTemplate set to `{{.Name}}.{{.Domain}}` the prod
// Service's Knative-known hostname matches what we put on the
// HTTPRoute, so Kourier routes by Host without a header rewrite.
function exposeHostname(slug: string): string {
  return `${prodServiceName(slug)}.${functionDomain()}`
}

function exposeRouteName(slug: string): string {
  return `function-fn-${slug}`
}

const GATEWAY_NAMESPACE =
  process.env.FUNCTION_GATEWAY_NAMESPACE ?? "platform-traefik"
const GATEWAY_NAME = process.env.FUNCTION_GATEWAY_NAME ?? "platform-gateway"

// Stand up the public HTTPRoute that fronts this function at
// <slug>.fn.<domain>. Backend = the Kourier ClusterIP service in
// kourier-system; cross-namespace ref is allowed by a one-time
// ReferenceGrant the platform installs at boot.
export async function ensureExposeRoute(slug: string): Promise<void> {
  const custom = k8sCustom()
  const name = exposeRouteName(slug)
  const body = {
    apiVersion: "gateway.networking.k8s.io/v1",
    kind: "HTTPRoute",
    metadata: {
      name,
      namespace: RESOURCE_NS,
      labels: {
        [FUNCTION_LABEL]: FUNCTION_LABEL_VALUE,
        [FUNCTION_SLUG_LABEL]: slug,
      },
    },
    spec: {
      parentRefs: [
        {
          name: GATEWAY_NAME,
          namespace: GATEWAY_NAMESPACE,
        },
      ],
      hostnames: [exposeHostname(slug)],
      rules: [
        {
          backendRefs: [
            {
              name: "kourier",
              namespace: "kourier-system",
              port: 80,
            },
          ],
        },
      ],
    },
  }

  try {
    const existing = (await custom.getNamespacedCustomObject({
      group: "gateway.networking.k8s.io",
      version: "v1",
      namespace: RESOURCE_NS,
      plural: "httproutes",
      name,
    })) as { metadata?: { resourceVersion?: string } }
    const merged = {
      ...body,
      metadata: {
        ...body.metadata,
        resourceVersion: existing.metadata?.resourceVersion,
      },
    }
    await custom.replaceNamespacedCustomObject({
      group: "gateway.networking.k8s.io",
      version: "v1",
      namespace: RESOURCE_NS,
      plural: "httproutes",
      name,
      body: merged,
    })
  } catch (err) {
    if (!isNotFound(err)) throw err
    await custom.createNamespacedCustomObject({
      group: "gateway.networking.k8s.io",
      version: "v1",
      namespace: RESOURCE_NS,
      plural: "httproutes",
      body,
    })
  }
}

export async function deleteExposeRoute(slug: string): Promise<void> {
  const custom = k8sCustom()
  await custom
    .deleteNamespacedCustomObject({
      group: "gateway.networking.k8s.io",
      version: "v1",
      namespace: RESOURCE_NS,
      plural: "httproutes",
      name: exposeRouteName(slug),
    })
    .catch((err) => {
      if (!isNotFound(err)) {
        log.warn(`deleteExposeRoute ${slug}: ${(err as Error).message}`)
      }
    })
}

// ----- Invoke proxy --------------------------------------------------------

// Forward an HTTP call to the function's Knative Service through
// Kourier (cluster-internal). Routing relies on the Host header
// matching `<ksvc>.<ns>.<domain>`.
//
// Why http.request instead of fetch: WHATWG fetch (Node 18+ / undici)
// treats `Host` as a forbidden header and silently overwrites it with
// the URL's hostname, which would always resolve to
// `kourier.kourier-system…` and 404 us out of every Knative route.
// http.request lets us set Host explicitly.
export async function invokeFunction(
  slug: string,
  request: {
    method: string
    path: string
    headers?: Record<string, string>
    body?: string
    // Which surface to call. Test tab defaults to dev so unsaved-but-
    // not-yet-deployed code is what gets exercised.
    target?: "dev" | "prod"
  },
): Promise<{
  status: number
  headers: Record<string, string>
  body: string
}> {
  const surface = request.target ?? "dev"
  const serviceName =
    surface === "prod" ? prodServiceName(slug) : devServiceName(slug)
  // Hostname has to match what Knative emits via its domainTemplate.
  // We changed the template to drop the namespace segment (so the
  // single-label `*.fn.<domain>` Gateway listener matches), so here
  // it's just `<service>.<domain>` — no RESOURCE_NS in between.
  const host = `${serviceName}.${functionDomain()}`
  const path = request.path.startsWith("/") ? request.path : `/${request.path}`
  const upstream = new URL(kourierUrl())
  if (upstream.protocol !== "http:") {
    throw new Error(
      `kourier URL must be http://, got ${upstream.protocol} (${kourierUrl()})`,
    )
  }
  const port = upstream.port ? Number(upstream.port) : 80

  // Strip caller-supplied Host so the explicit one wins.
  const cleanCallerHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(request.headers ?? {})) {
    if (k.toLowerCase() === "host") continue
    cleanCallerHeaders[k] = v
  }
  const method = request.method.toUpperCase()
  const body =
    method === "GET" || method === "HEAD" ? undefined : (request.body ?? "")
  const headers: Record<string, string> = {
    ...cleanCallerHeaders,
    host: host,
    "x-forwarded-host": host,
    "content-length": String(body ? Buffer.byteLength(body, "utf8") : 0),
  }

  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: upstream.hostname,
        port,
        method,
        path,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer | string) => {
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
        })
        res.on("end", () => {
          const responseHeaders: Record<string, string> = {}
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) responseHeaders[k] = v.join(", ")
            else if (typeof v === "string") responseHeaders[k] = v
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: responseHeaders,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        })
        res.on("error", reject)
      },
    )
    req.on("error", reject)
    if (body) req.write(body)
    req.end()
  })
}

// ----- helpers -------------------------------------------------------------

function isNotFound(err: unknown): boolean {
  const e = err as { code?: number; statusCode?: number; status?: number }
  return e?.code === 404 || e?.statusCode === 404 || e?.status === 404
}
