export type VmImageType = "base" | "desktop"
export type VmAgentType = "hermes" | "none"

export type VmStatus = "Pending" | "Running" | "Failed" | "Unknown"

export type Vm = {
  id: string
  name: string
  owner: string
  namespace: string
  imageType: VmImageType
  agentType: VmAgentType
  status: VmStatus
  hostname: string
  createdAt: string
  // Launch URLs. xterm is available on every VM (ttyd:7681); vnc only on
  // the desktop image (KasmVNC:6901).
  xtermUrl: string
  vncUrl: string | null
}

export type CreateVmInput = {
  name: string
  imageType: VmImageType
  agentType: VmAgentType
  storageSize?: string
}

// VM-derived label/annotation keys. Centralized so list/create stay in
// sync — list filters by VM_LABEL=true, create stamps the same.
export const VM_LABEL = "agent-platform/component"
export const VM_LABEL_VALUE = "vm"
export const VM_OWNER_LABEL = "agent-platform/vm-owner"
export const VM_IMAGE_TYPE_LABEL = "agent-platform/vm-image-type"
export const VM_AGENT_TYPE_LABEL = "agent-platform/vm-agent-type"
