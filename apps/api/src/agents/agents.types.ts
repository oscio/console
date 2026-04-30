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
  // OpenRouter model id surfaced to the pod as ZEROCLAW_DEFAULT_MODEL.
  // Shape-validated against AGENT_MODEL_RE at the controller boundary;
  // ignored for hermes (which has its own provider config). When
  // unset, entrypoint.sh's hard default applies.
  model?: string
  // Optional VM slug to attach to. When set, the agent pod gets the
  // SSH shim wired (SSH_HOST = <boundToVm>.resource.svc, SSH_KEY =
  // mounted Secret) and mounts the same workspace PVC the VM does.
  // Caller (VmsService) is responsible for creating the SSH key
  // Secret + the workspace PVC mount before calling.
  boundToVm?: string
  // Volume claim slug to mount at /home/coder/workspace when bound.
  // Set together with boundToVm; ignored otherwise.
  workspaceVolumeSlug?: string
  // K8s Secret name holding id_ed25519 (private key, mounted on
  // agent pod) and authorized_keys (public, mounted on VM pod).
  sshKeySecretName?: string
}

// Agent-derived label/annotation keys. Mirrors VM_* but keyed under
// `agent` so the two resource types coexist cleanly under shared
// listers/selectors.
export const AGENT_LABEL = "agent-platform/component"
export const AGENT_LABEL_VALUE = "agent"
export const AGENT_OWNER_LABEL = "agent-platform/agent-owner"
export const AGENT_TYPE_LABEL = "agent-platform/agent-type"
// Set on attached agents. Empty / unset = standalone (headless).
// Used by listForOwner to populate Agent.boundToVm and by VmsService
// to find agents to cascade-delete.
export const AGENT_BOUND_TO_VM_LABEL = "agent-platform/agent-bound-to-vm"

export const AGENT_DISPLAY_NAME_ANNOTATION =
  "agent-platform/agent-display-name"

// The agent gateway speaks on a fixed port. Static so the pod, the
// Service, and the HTTPRoute all agree without extra wiring.
export const AGENT_PORT = 8000

// Server-side shape check for the model id supplied at create time.
// The web layer fetches the live OpenRouter catalog (so the dropdown
// stays in sync with reality) — we don't try to mirror that catalog
// here. This regex matches the `provider/model[:tag]` shape openrouter
// emits and rejects anything that could be confused for a path or
// shell metachar.
export const AGENT_MODEL_RE = /^[a-z0-9._-]+\/[a-zA-Z0-9._:+-]+$/

// Cluster-wide Secret holding shared agent env (OPENROUTER_API_KEY
// and friends). Mounted via envFrom on every agent pod, alongside
// the per-agent Secret. Managed in /settings by console-admins.
export const GLOBAL_AGENT_ENV_SECRET = "agent-platform-global-env"
