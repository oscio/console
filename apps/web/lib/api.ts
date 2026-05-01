// Server-side calls (RSC) hit the api on the docker-compose network via
// API_URL_INTERNAL. Outside compose the var is unset and we fall back to
// the public URL.
const API_URL =
  process.env.API_URL_INTERNAL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:3001"

export type Account = {
  id: string
  email: string
  name: string | null
  image: string | null
  groups: string[]
  // Keycloak-sourced (the `platform-admin` group claim). Never grantable
  // in-app — Keycloak owns this role.
  isPlatformAdmin: boolean
  // OpenFGA-sourced (`platform#console_admin` tuple). Granted/revoked by
  // platform-admins via /role-bindings.
  isConsoleAdmin: boolean
}

export type AccountListEntry = Account & { createdAt: string }

export async function fetchMe(cookieHeader: string): Promise<Account | null> {
  const res = await fetch(`${API_URL}/accounts/me`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  })
  if (res.status === 401) return null
  if (!res.ok) {
    throw new Error(`accounts/me failed: ${res.status}`)
  }
  return (await res.json()) as Account
}

// Returns null when the caller can't view the user list (401/403),
// so callers can gate UI on a single nullable result.
export async function fetchAccounts(
  cookieHeader: string,
): Promise<AccountListEntry[] | null> {
  const res = await fetch(`${API_URL}/accounts`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  })
  if (res.status === 401 || res.status === 403) return null
  if (!res.ok) {
    throw new Error(`accounts failed: ${res.status}`)
  }
  return (await res.json()) as AccountListEntry[]
}

// Hard-delete a user account. Platform-admin only on the api side.
export async function deleteAccount(
  cookieHeader: string,
  userId: string,
): Promise<void> {
  const res = await fetch(`${API_URL}/accounts/${userId}`, {
    method: "DELETE",
    headers: { cookie: cookieHeader },
    cache: "no-store",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`accounts delete failed: ${res.status} ${text}`)
  }
}

// Grant/revoke the `console-admin` role on a user. Platform-admin only on
// the api side; this client just forwards the cookie.
export async function setConsoleAdminRole(
  cookieHeader: string,
  userId: string,
  grant: boolean,
): Promise<void> {
  const res = await fetch(`${API_URL}/role-bindings/console-admin/${userId}`, {
    method: grant ? "PUT" : "DELETE",
    headers: { cookie: cookieHeader },
    cache: "no-store",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(
      `role-bindings ${grant ? "grant" : "revoke"} failed: ${res.status} ${text}`,
    )
  }
}

export type VmImageType = "base" | "desktop"
export type VmAgentType = "none" | "hermes" | "zeroclaw"
export type VmStatus = "Pending" | "Running" | "Failed" | "Unknown"

export type Vm = {
  id: string
  slug: string
  name: string
  owner: string
  namespace: string
  imageType: VmImageType
  agentType: VmAgentType
  status: VmStatus
  hostname: string
  // Resource requests on the workspace container, K8s-native form
  // (e.g. "2", "4Gi"). Surfaced for the VM detail card.
  cpu: string
  memory: string
  createdAt: string
  xtermUrl: string
  codeUrl: string
  vncUrl: string | null
}

export async function fetchVms(cookieHeader: string): Promise<Vm[] | null> {
  const res = await fetch(`${API_URL}/vms`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  })
  if (res.status === 401 || res.status === 403) return null
  if (!res.ok) throw new Error(`vms list failed: ${res.status}`)
  return (await res.json()) as Vm[]
}

// Defaults match VM_DEFAULTS on the api. Surfaced as the slider
// recommendation in the create modal — keep these in sync.
export const VM_DEFAULTS = {
  cpu: "2",
  memory: "4Gi",
  volumeSizeGi: 1,
} as const

export type VmVolumeMode = "new" | "attach" | "none"

export async function createVm(
  cookieHeader: string,
  input: {
    name: string
    imageType: VmImageType
    agentType: VmAgentType
    cpuRequest?: string
    memoryRequest?: string
    volumeMode: VmVolumeMode
    volumeName?: string
    volumeSizeGi?: number
    persistVolumeOnDelete?: boolean
    volumeSlug?: string
    loadBalancers?: Array<{
      name?: string
      port: number
    }>
    // OpenRouter model id for the attached agent (zeroclaw only).
    agentModel?: string
    // kubectl access tier the VM gets. "none" = no SA token, no
    // kubectl. Other tiers are admin-only on the server side.
    kubectlAccess?: "none" | "resource-admin" | "cluster-admin"
  },
): Promise<Vm> {
  const res = await fetch(`${API_URL}/vms`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
    cache: "no-store",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`vms create failed: ${res.status} ${text}`)
  }
  return (await res.json()) as Vm
}

// Identifies the VM by its random slug (K8s resource name), not the
// user's display name — display names aren't unique.
export async function deleteVm(
  cookieHeader: string,
  slug: string,
): Promise<void> {
  const res = await fetch(
    `${API_URL}/vms/${encodeURIComponent(slug)}`,
    { method: "DELETE", headers: { cookie: cookieHeader }, cache: "no-store" },
  )
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "")
    throw new Error(`vms delete failed: ${res.status} ${text}`)
  }
}

// Rename a VM by patching its display-name annotation. Slug stays.
export async function renameVm(
  cookieHeader: string,
  slug: string,
  name: string,
): Promise<void> {
  const res = await fetch(`${API_URL}/vms/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: { cookie: cookieHeader, "content-type": "application/json" },
    body: JSON.stringify({ name }),
    cache: "no-store",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`vms rename failed: ${res.status} ${text}`)
  }
}

export type AgentType = "hermes" | "zeroclaw"
export type AgentStatus = VmStatus

export type Agent = {
  id: string
  slug: string
  name: string
  owner: string
  namespace: string
  agentType: AgentType
  status: AgentStatus
  hostname: string
  createdAt: string
  gatewayUrl: string
  // Set when this agent is a VM sidecar (slug = vm-XXX). null for
  // standalone agents created via /agents directly.
  boundToVm: string | null
}

export async function fetchAgents(
  cookieHeader: string,
): Promise<Agent[] | null> {
  const res = await fetch(`${API_URL}/agents`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  })
  if (res.status === 401 || res.status === 403) return null
  if (!res.ok) throw new Error(`agents list failed: ${res.status}`)
  return (await res.json()) as Agent[]
}

export async function createAgent(
  cookieHeader: string,
  input: {
    name: string
    agentType: AgentType
    // OpenRouter model id (zeroclaw only — ignored for hermes).
    // Surfaces as ZEROCLAW_DEFAULT_MODEL on the pod.
    model?: string
  },
): Promise<Agent> {
  const res = await fetch(`${API_URL}/agents`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
    cache: "no-store",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`agents create failed: ${res.status} ${text}`)
  }
  return (await res.json()) as Agent
}

export async function deleteAgent(
  cookieHeader: string,
  slug: string,
): Promise<void> {
  const res = await fetch(
    `${API_URL}/agents/${encodeURIComponent(slug)}`,
    { method: "DELETE", headers: { cookie: cookieHeader }, cache: "no-store" },
  )
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "")
    throw new Error(`agents delete failed: ${res.status} ${text}`)
  }
}

export async function renameAgent(
  cookieHeader: string,
  slug: string,
  name: string,
): Promise<void> {
  const res = await fetch(`${API_URL}/agents/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: { cookie: cookieHeader, "content-type": "application/json" },
    body: JSON.stringify({ name }),
    cache: "no-store",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`agents rename failed: ${res.status} ${text}`)
  }
}

// ---------- agent chat ----------
//
// All chat traffic goes through console-api at /agents/<slug>/chat/...
// The api proxies to the in-cluster wrapper sidecar; SSE streaming
// is the wrapper's text/event-stream piped straight through.

export type AgentSession = {
  session_id: string
  name: string
  agent_type: string
  created_at: number
}

export type AgentTaskStatus =
  | "running"
  | "done"
  | "failed"
  | "interrupted"

export type AgentTaskEvent = {
  ts: number
  type: string
  // Adapter-specific payload — kept loose since the wrapper's
  // adapters can introduce new event types without UI change.
  [key: string]: unknown
}

export type AgentTask = {
  task_id: string
  session_id: string
  agent_type: string
  status: AgentTaskStatus
  started_at: number
  finished_at?: number
  exit_code?: number
  cmd?: string[]
  events?: AgentTaskEvent[]
}

export async function listAgentSessions(
  cookieHeader: string,
  slug: string,
): Promise<AgentSession[]> {
  const res = await fetch(
    `${API_URL}/agents/${encodeURIComponent(slug)}/chat/sessions`,
    { headers: { cookie: cookieHeader }, cache: "no-store" },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`agent sessions list failed: ${res.status} ${text}`)
  }
  return (await res.json()) as AgentSession[]
}

export async function createAgentSession(
  cookieHeader: string,
  slug: string,
  input: { name?: string } = {},
): Promise<AgentSession> {
  const res = await fetch(
    `${API_URL}/agents/${encodeURIComponent(slug)}/chat/sessions`,
    {
      method: "POST",
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`agent session create failed: ${res.status} ${text}`)
  }
  return (await res.json()) as AgentSession
}

export async function createAgentTask(
  cookieHeader: string,
  slug: string,
  input: { session_id: string; prompt: string },
): Promise<{ task_id: string; session_id: string; status: string }> {
  const res = await fetch(
    `${API_URL}/agents/${encodeURIComponent(slug)}/chat/tasks`,
    {
      method: "POST",
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`agent task create failed: ${res.status} ${text}`)
  }
  return (await res.json()) as {
    task_id: string
    session_id: string
    status: string
  }
}

export async function getAgentTask(
  cookieHeader: string,
  slug: string,
  taskId: string,
): Promise<AgentTask> {
  const res = await fetch(
    `${API_URL}/agents/${encodeURIComponent(slug)}/chat/tasks/${encodeURIComponent(taskId)}`,
    { headers: { cookie: cookieHeader }, cache: "no-store" },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`agent task get failed: ${res.status} ${text}`)
  }
  return (await res.json()) as AgentTask
}

export async function cancelAgentTask(
  cookieHeader: string,
  slug: string,
  taskId: string,
): Promise<void> {
  const res = await fetch(
    `${API_URL}/agents/${encodeURIComponent(slug)}/chat/tasks/${encodeURIComponent(taskId)}/cancel`,
    {
      method: "POST",
      headers: { cookie: cookieHeader },
      cache: "no-store",
    },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`agent task cancel failed: ${res.status} ${text}`)
  }
}

export type VolumeStatus =
  | "Available"
  | "Bound"
  | "Pending"
  | "Released"
  | "Failed"
  | "Unknown"

export type Volume = {
  id: string
  slug: string
  name: string
  owner: string
  namespace: string
  status: VolumeStatus
  sizeGi: number
  // VM slug currently mounting this volume, or null when free.
  boundTo: string | null
  createdAt: string
}

export const VOLUME_DEFAULTS = { sizeGi: 1 } as const

export async function fetchVolumes(
  cookieHeader: string,
): Promise<Volume[] | null> {
  const res = await fetch(`${API_URL}/volumes`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  })
  if (res.status === 401 || res.status === 403) return null
  if (!res.ok) throw new Error(`volumes list failed: ${res.status}`)
  return (await res.json()) as Volume[]
}

export async function createVolume(
  cookieHeader: string,
  input: { name: string; sizeGi: number },
): Promise<Volume> {
  const res = await fetch(`${API_URL}/volumes`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
    cache: "no-store",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`volumes create failed: ${res.status} ${text}`)
  }
  return (await res.json()) as Volume
}

export async function deleteVolume(
  cookieHeader: string,
  slug: string,
): Promise<void> {
  const res = await fetch(
    `${API_URL}/volumes/${encodeURIComponent(slug)}`,
    { method: "DELETE", headers: { cookie: cookieHeader }, cache: "no-store" },
  )
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "")
    throw new Error(`volumes delete failed: ${res.status} ${text}`)
  }
}

export async function renameVolume(
  cookieHeader: string,
  slug: string,
  name: string,
): Promise<void> {
  const res = await fetch(`${API_URL}/volumes/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: { cookie: cookieHeader, "content-type": "application/json" },
    body: JSON.stringify({ name }),
    cache: "no-store",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`volumes rename failed: ${res.status} ${text}`)
  }
}

export type LoadBalancerStatus = "Ready" | "Pending" | "Unknown"

export type LoadBalancer = {
  id: string
  slug: string
  name: string
  owner: string
  namespace: string
  vmSlug: string
  port: number
  hostname: string
  url: string
  status: LoadBalancerStatus
  createdAt: string
}

export async function fetchLoadBalancers(
  cookieHeader: string,
): Promise<LoadBalancer[] | null> {
  const res = await fetch(`${API_URL}/loadbalancers`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  })
  if (res.status === 401 || res.status === 403) return null
  if (!res.ok) throw new Error(`loadbalancers list failed: ${res.status}`)
  return (await res.json()) as LoadBalancer[]
}

export async function createLoadBalancer(
  cookieHeader: string,
  input: {
    name: string
    vmSlug: string
    port: number
  },
): Promise<LoadBalancer> {
  const res = await fetch(`${API_URL}/loadbalancers`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
    cache: "no-store",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`loadbalancers create failed: ${res.status} ${text}`)
  }
  return (await res.json()) as LoadBalancer
}

export async function deleteLoadBalancer(
  cookieHeader: string,
  slug: string,
): Promise<void> {
  const res = await fetch(
    `${API_URL}/loadbalancers/${encodeURIComponent(slug)}`,
    { method: "DELETE", headers: { cookie: cookieHeader }, cache: "no-store" },
  )
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "")
    throw new Error(`loadbalancers delete failed: ${res.status} ${text}`)
  }
}

export async function renameLoadBalancer(
  cookieHeader: string,
  slug: string,
  name: string,
): Promise<void> {
  const res = await fetch(
    `${API_URL}/loadbalancers/${encodeURIComponent(slug)}`,
    {
      method: "PATCH",
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      body: JSON.stringify({ name }),
      cache: "no-store",
    },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`loadbalancers rename failed: ${res.status} ${text}`)
  }
}

// Functions (Services > Functions). Phase-2: each function is backed
// by a Forgejo repo under the `service` org; visibility (public/
// private) is FGA-driven via a `user:* viewer` wildcard tuple.

export const FUNCTION_RUNTIMES = ["node20", "python3.12"] as const
export type FunctionRuntime = (typeof FUNCTION_RUNTIMES)[number]
export type FunctionStatus = "Draft"

export type Func = {
  id: string
  slug: string
  name: string
  owner: string
  runtime: FunctionRuntime
  status: FunctionStatus
  // True when anyone signed-in can read; owner can still rename/delete.
  public: boolean
  // Web URL into Forgejo. "" when the client isn't configured yet.
  forgejoUrl: string
  createdAt: string
}

export async function fetchFunctions(
  cookieHeader: string,
): Promise<Func[] | null> {
  const res = await fetch(`${API_URL}/functions`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  })
  if (res.status === 401 || res.status === 403) return null
  if (!res.ok) throw new Error(`functions list failed: ${res.status}`)
  return (await res.json()) as Func[]
}

export async function createFunction(
  cookieHeader: string,
  input: { name: string; runtime: FunctionRuntime; public?: boolean },
): Promise<Func> {
  const res = await fetch(`${API_URL}/functions`, {
    method: "POST",
    headers: { cookie: cookieHeader, "content-type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`functions create failed: ${res.status} ${text}`)
  }
  return (await res.json()) as Func
}

export async function deleteFunction(
  cookieHeader: string,
  slug: string,
): Promise<void> {
  const res = await fetch(`${API_URL}/functions/${encodeURIComponent(slug)}`, {
    method: "DELETE",
    headers: { cookie: cookieHeader },
    cache: "no-store",
  })
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "")
    throw new Error(`functions delete failed: ${res.status} ${text}`)
  }
}

export async function renameFunction(
  cookieHeader: string,
  slug: string,
  name: string,
): Promise<void> {
  const res = await fetch(`${API_URL}/functions/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: { cookie: cookieHeader, "content-type": "application/json" },
    body: JSON.stringify({ name }),
    cache: "no-store",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`functions rename failed: ${res.status} ${text}`)
  }
}

export type FunctionFiles = {
  // User-editable folder inside the function repo (e.g. "function").
  // Anything outside is platform-managed.
  folder: string
  // Monaco language id ("python", "javascript", ...).
  language: string
  // Path the editor opens onto by default (e.g. "function/main.py").
  defaultFile: string
  // All files under `folder`, defaultFile-first then alphabetical.
  files: { path: string; content: string }[]
}

export async function fetchFunctionFiles(
  cookieHeader: string,
  slug: string,
): Promise<FunctionFiles> {
  const res = await fetch(
    `${API_URL}/functions/${encodeURIComponent(slug)}/files`,
    { headers: { cookie: cookieHeader }, cache: "no-store" },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`functions files fetch failed: ${res.status} ${text}`)
  }
  return (await res.json()) as FunctionFiles
}

export async function saveFunctionFiles(
  cookieHeader: string,
  slug: string,
  input: {
    files?: { path: string; content: string }[]
    deletes?: string[]
    message?: string
  },
): Promise<void> {
  const res = await fetch(
    `${API_URL}/functions/${encodeURIComponent(slug)}/files`,
    {
      method: "PUT",
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`functions files save failed: ${res.status} ${text}`)
  }
}

export async function setFunctionVisibility(
  cookieHeader: string,
  slug: string,
  isPublic: boolean,
): Promise<void> {
  const res = await fetch(
    `${API_URL}/functions/${encodeURIComponent(slug)}/visibility`,
    {
      method: "PUT",
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      body: JSON.stringify({ public: isPublic }),
      cache: "no-store",
    },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`functions visibility put failed: ${res.status} ${text}`)
  }
}

// Global agent env (cluster-wide Secret keyed by env-var name).
// The api returns plain values for admins so the settings UI can
// show what's currently stored. Endpoint is admin-gated.

export type GlobalEnvKey = { name: string; value: string }

export async function fetchGlobalEnv(
  cookieHeader: string,
): Promise<GlobalEnvKey[] | null> {
  const res = await fetch(`${API_URL}/admin/global-env`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  })
  if (res.status === 401 || res.status === 403) return null
  if (!res.ok) {
    throw new Error(`admin/global-env failed: ${res.status}`)
  }
  const body = (await res.json()) as { keys: GlobalEnvKey[] }
  return body.keys
}

// Empty string clears the key (treated as a delete on the api).
export async function setGlobalEnv(
  cookieHeader: string,
  key: string,
  value: string,
): Promise<void> {
  const res = await fetch(
    `${API_URL}/admin/global-env/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      body: JSON.stringify({ value }),
      cache: "no-store",
    },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`global-env put failed: ${res.status} ${text}`)
  }
}

// Branding for the sign-in page (color OR image, title, optional
// description). GET is public — sign-in page renders before auth —
// PUT is admin-gated.

export type Branding = {
  color: string
  textColor: string
  imageUrl: string
  title: string
  description: string
}

export async function fetchBranding(
  cookieHeader?: string,
): Promise<Branding> {
  const res = await fetch(`${API_URL}/branding`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: "no-store",
  })
  if (!res.ok) {
    throw new Error(`branding fetch failed: ${res.status}`)
  }
  return (await res.json()) as Branding
}

export async function saveBranding(
  cookieHeader: string,
  branding: Branding,
): Promise<void> {
  const res = await fetch(`${API_URL}/branding`, {
    method: "PUT",
    headers: { cookie: cookieHeader, "content-type": "application/json" },
    body: JSON.stringify(branding),
    cache: "no-store",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`branding put failed: ${res.status} ${text}`)
  }
}
