import { Logger } from "@nestjs/common"
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
// runner picks up edits without a rebuild. Update strategy is
// GET → replace (PUT) rather than PATCH — the @kubernetes/client-node
// v1 typed client defaults to application/json-patch+json content
// type, which expects a JSON Patch array; sending an object body
// crashes with "cannot unmarshal object into []handlers.jsonPatchOp".
export async function ensureKnativeService(slug: string): Promise<void> {
  const custom = k8sCustom()
  const name = knativeServiceName(slug)
  const cm = configMapName(slug)

  const desired = buildKnativeServiceBody({ name, slug, configMap: cm })

  let existing: { metadata?: { resourceVersion?: string } } | null = null
  try {
    const res = (await custom.getNamespacedCustomObject({
      group: "serving.knative.dev",
      version: "v1",
      namespace: RESOURCE_NS,
      plural: "services",
      name,
    })) as { metadata?: { resourceVersion?: string } }
    existing = res
  } catch (err) {
    if (!isNotFound(err)) throw err
  }

  if (existing) {
    desired.metadata.resourceVersion = existing.metadata?.resourceVersion
    await custom.replaceNamespacedCustomObject({
      group: "serving.knative.dev",
      version: "v1",
      namespace: RESOURCE_NS,
      plural: "services",
      name,
      body: desired,
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
// Kourier (cluster-internal). We avoid going through Traefik so dev
// invocations don't need external DNS / TLS — Kourier ClusterIP +
// Host header rewrite is enough for the in-cluster path.
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
  const url = `${kourierUrl().replace(/\/$/, "")}${path}`

  // Default headers + caller-supplied. Force Host so Kourier routes
  // to the right Knative Service; user-set Host gets ignored.
  const headers: Record<string, string> = {
    ...(request.headers ?? {}),
    host: host,
    "X-Forwarded-Host": host,
  }

  const res = await fetch(url, {
    method: request.method.toUpperCase(),
    headers,
    body:
      request.method.toUpperCase() === "GET" ||
      request.method.toUpperCase() === "HEAD"
        ? undefined
        : (request.body ?? ""),
  })
  const text = await res.text().catch(() => "")
  const responseHeaders: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })
  return {
    status: res.status,
    headers: responseHeaders,
    body: text,
  }
}

// ----- helpers -------------------------------------------------------------

function isNotFound(err: unknown): boolean {
  const e = err as { code?: number; statusCode?: number; status?: number }
  return e?.code === 404 || e?.statusCode === 404 || e?.status === 404
}
