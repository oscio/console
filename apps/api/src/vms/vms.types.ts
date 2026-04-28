export type VmImageType = "base" | "desktop"
// `agentType` is a placeholder for now — future in-VM agents will be
// wired by a `.sh` entrypoint, not selected at create time. Keeping
// the field on the resource (label + API surface) so we don't break
// existing tuples; "none" is the only value today.
export type VmAgentType = "none"

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

// Display name lives in an annotation (not a label) because labels can't
// hold arbitrary Unicode / spaces — the slug carries the K8s identity.
export const VM_DISPLAY_NAME_ANNOTATION = "agent-platform/vm-display-name"
