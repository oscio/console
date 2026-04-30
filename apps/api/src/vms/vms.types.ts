export type VmImageType = "base" | "desktop"
// `agentType` selects whether (and which) agent sidecar gets attached
// to the VM pod. "none" = no sidecar. Otherwise the chosen value is
// passed to the agent runtime via AGENT_TYPE — see
// services/agents/wrapper/adapters/ for the supported list.
export type VmAgentType = "none" | "hermes" | "zeroclaw"

export type VmStatus = "Pending" | "Running" | "Failed" | "Unknown"

export type Vm = {
  // K8s resource UID — opaque, stable for the lifetime of the resource.
  id: string
  // Random slug used as the K8s resource name + DNS hostname. Stable
  // and DNS-safe regardless of what the user typed for `name`.
  slug: string
  // Free-form display label the user typed at create time. Just for
  // humans — never used in DNS, paths, or K8s names.
  name: string
  owner: string
  namespace: string
  imageType: VmImageType
  agentType: VmAgentType
  status: VmStatus
  hostname: string
  createdAt: string
  // Launch URLs — all path-based on the console hostname so they share
  // its (browser-trusted) cert. The HTTPRoute's URLRewrite strips the
  // prefix; the upstream sees the request at `/`.
  //   xtermUrl: ttyd  (7681) — every VM
  //   codeUrl : code-server (8080) — every VM
  //   vncUrl  : KasmVNC (6901) — desktop image only
  xtermUrl: string
  codeUrl: string
  vncUrl: string | null
}

// Volume attach mode at VM-create time:
//   "new"    → provision a fresh PVC + bind it
//   "attach" → bind to an existing free PVC (volumeSlug required)
//   "none"   → no PVC, ephemeral container fs only
export type VmVolumeMode = "new" | "attach" | "none"

export type CreateVmInput = {
  name: string
  imageType: VmImageType
  agentType: VmAgentType
  cpuRequest?: string
  memoryRequest?: string

  // Volume attachment.
  volumeMode: VmVolumeMode
  // For "new": display name + size. Optional volumeName falls back
  // to "<vm-display-name> volume" if omitted.
  volumeName?: string
  volumeSizeGi?: number
  // When true (and mode=new), the PVC outlives VM delete and shows
  // up under /volumes for re-attach. Default false (delete with VM).
  persistVolumeOnDelete?: boolean
  // For "attach": slug of the existing free volume.
  volumeSlug?: string

  // OpenRouter model id for the attached agent. Forwarded as-is to
  // AgentsService.create's `model`. Ignored when agentType="none".
  agentModel?: string

  // Optional convenience LBs. The api creates one LoadBalancer per
  // entry pointing at the new VM. Empty/undefined = no LBs at create
  // time (users can still add them from /loadbalancers).
  loadBalancers?: Array<{
    // Display name. Falls back to "<vm-name> :<port>" on the api when blank.
    name?: string
    port: number
  }>
}

// Defaults shown in the UI as "Recommended" + applied when caller
// omits the field. Sized for a 1-user dev workspace; bumpable on the
// dial.
export const VM_DEFAULTS = {
  cpu: "2",
  memory: "4Gi",
  volumeSizeGi: 1,
} as const

// Pod-spec volume name + mount path used for the VM's data volume.
// Path matches agent-sandbox's workspace dir (/home/coder/workspace,
// owned by UID 1000) — same UID as the agent sidecar so a shared
// PVC mount works for both containers.
export const VM_DATA_VOLUME_NAME = "data"
export const VM_DATA_MOUNT_PATH = "/home/coder/workspace"

// Annotations the api stamps on the StatefulSet so VM delete knows
// whether the bound PVC should be cleaned up or left for re-attach.
export const VM_VOLUME_SLUG_ANNOTATION = "agent-platform/vm-volume-slug"
export const VM_VOLUME_PERSIST_ANNOTATION = "agent-platform/vm-volume-persist"

// VM-derived label/annotation keys. Centralized so list/create stay in
// sync — list filters by VM_LABEL=true, create stamps the same.
export const VM_LABEL = "agent-platform/component"
export const VM_LABEL_VALUE = "vm"
export const VM_OWNER_LABEL = "agent-platform/vm-owner"
export const VM_IMAGE_TYPE_LABEL = "agent-platform/vm-image-type"
export const VM_AGENT_TYPE_LABEL = "agent-platform/vm-agent-type"

// Display name lives in an annotation (not a label) because labels can't
// hold arbitrary Unicode / spaces — the slug carries the K8s identity.
export const VM_DISPLAY_NAME_ANNOTATION = "agent-platform/vm-display-name"
