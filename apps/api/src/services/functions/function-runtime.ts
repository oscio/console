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

export function knativeServiceName(slug: string): string {
  // Slug already starts `function-` so we'd otherwise end up with
  // `function-function-XXXX` — keep it just `<slug>`.
  return slug
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

// The dev pod mounts the ConfigMap at /app/function so the dev
// runner picks up edits without a rebuild.
//
// Update strategy is GET → modify-spec → replace (PUT). Knative's
// admission webhook treats `metadata.annotations.serving.knative.dev/
// creator` (and a few siblings) as immutable, so a wholesale replace
// with a freshly-built body is rejected. Instead we keep the
// existing object as the base, swap only `spec` + the bits of our
// `metadata.labels` we care about, and PUT.
//
// (Patch with an object body would be cleaner but the
// @kubernetes/client-node v1 typed client defaults to
// application/json-patch+json content type, which expects a JSON
// Patch array.)
export async function ensureKnativeService(slug: string): Promise<void> {
  const custom = k8sCustom()
  const name = knativeServiceName(slug)
  const cm = configMapName(slug)

  const desired = buildKnativeServiceBody({ name, slug, configMap: cm })

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
    const res = (await custom.getNamespacedCustomObject({
      group: "serving.knative.dev",
      version: "v1",
      namespace: RESOURCE_NS,
      plural: "services",
      name,
    })) as KsvcShape
    existing = res
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
        // annotations preserved as-is from existing — Knative-managed.
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

function buildKnativeServiceBody(input: {
  name: string
  slug: string
  configMap: string
}): KnativeServiceBody {
  return {
    apiVersion: "serving.knative.dev/v1",
    kind: "Service",
    metadata: {
      name: input.name,
      namespace: RESOURCE_NS,
      labels: {
        [FUNCTION_LABEL]: FUNCTION_LABEL_VALUE,
        [FUNCTION_SLUG_LABEL]: input.slug,
      },
    },
    spec: {
      template: {
        metadata: {
          // Knative reads this as part of the Revision template;
          // changing it forces a new Revision (= new pod). We bump
          // it on every ensureKnativeService so a no-op Deploy
          // still rolls fresh ConfigMap content.
          annotations: {
            "agent-platform/code-version": String(Date.now()),
          },
        },
        spec: {
          containers: [
            {
              image: devImage(),
              ports: [{ containerPort: 8080 }],
              volumeMounts: [
                {
                  name: "code",
                  mountPath: "/app/function",
                },
              ],
            },
          ],
          volumes: [
            {
              name: "code",
              configMap: { name: input.configMap },
            },
          ],
        },
      },
    },
  }
}

export async function deleteKnativeService(slug: string): Promise<void> {
  const custom = k8sCustom()
  await custom
    .deleteNamespacedCustomObject({
      group: "serving.knative.dev",
      version: "v1",
      namespace: RESOURCE_NS,
      plural: "services",
      name: knativeServiceName(slug),
    })
    .catch((err) => {
      if (!isNotFound(err)) {
        log.warn(`deleteKnativeService ${slug}: ${(err as Error).message}`)
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
  },
): Promise<{
  status: number
  headers: Record<string, string>
  body: string
}> {
  const host = `${knativeServiceName(slug)}.${RESOURCE_NS}.${functionDomain()}`
  const path = request.path.startsWith("/") ? request.path : `/${request.path}`
  const target = new URL(kourierUrl())
  if (target.protocol !== "http:") {
    throw new Error(
      `kourier URL must be http://, got ${target.protocol} (${kourierUrl()})`,
    )
  }
  const port = target.port ? Number(target.port) : 80

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
        host: target.hostname,
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
