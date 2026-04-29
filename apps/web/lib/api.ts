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
export type VmAgentType = "none"
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
    loadBalancerPort?: number
    loadBalancerName?: string
    loadBalancerPersistOnVmDelete?: boolean
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

export type AgentType = "hermes" | "openclaw"
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
    storageSize?: string
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
    persistOnVmDelete?: boolean
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
