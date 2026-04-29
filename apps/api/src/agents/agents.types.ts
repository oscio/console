// Agent runtime — picks which adapter the FastAPI wrapper inside the
// pod dispatches to. Add a new value here and a matching adapter in
// services/agents/wrapper/adapters/ to onboard a new agent.
export type AgentType = "hermes" | "zeroclaw"

export type AgentStatus = "Pending" | "Running" | "Failed" | "Unknown"

export type Agent = {
  // K8s resource UID — opaque, stable for the lifetime of the resource.
  id: string
  // Random slug used as the K8s resource name + DNS hostname. Stable
  // and DNS-safe regardless of what the user typed for `name`. For
  // standalone agents this is `agent-XXXXXXXX`; for VM-attached
  // sidecars it's the VM's slug `vm-XXXXXXXX`.
  slug: string
  // Free-form display label the user typed at create time.
  name: string
  owner: string
  namespace: string
  agentType: AgentType
  status: AgentStatus
  hostname: string
  createdAt: string
  // Single per-agent launch URL — the agent gateway on port 8000.
  // Path-routed through oauth2-proxy /oauth2/start the same way
  // VM URLs are.
  gatewayUrl: string
  // VM slug this agent rides as a sidecar in, or null for standalone
  // agents. UI uses this to render an "attached to <vm-name>" badge
  // on the /agents listing.
  boundToVm: string | null
}

export type CreateAgentInput = {
  name: string
  agentType: AgentType
}

// Agent-derived label/annotation keys. Mirrors VM_* but keyed under
// `agent` so the two resource types coexist cleanly under shared
// listers/selectors.
export const AGENT_LABEL = "agent-platform/component"
export const AGENT_LABEL_VALUE = "agent"
export const AGENT_OWNER_LABEL = "agent-platform/agent-owner"
export const AGENT_TYPE_LABEL = "agent-platform/agent-type"

export const AGENT_DISPLAY_NAME_ANNOTATION =
  "agent-platform/agent-display-name"

// The agent gateway speaks on a fixed port. Static so the pod, the
// Service, and the HTTPRoute all agree without extra wiring.
export const AGENT_PORT = 8000
