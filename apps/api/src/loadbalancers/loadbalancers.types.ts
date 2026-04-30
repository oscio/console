// LoadBalancers expose a single port on a VM under a per-LB hostname
// `<slug>.lb.<domain>`. Each LB creates a ClusterIP Service +
// HTTPRoute pair in the owner's `resource-vm-<owner>` namespace. The
// Service selects the target VM's pod via the `vm-slug` label, so
// the LB only stays healthy while that VM is running.

export type LoadBalancerStatus = "Ready" | "Pending" | "Unknown"

export type LoadBalancer = {
  // K8s HTTPRoute UID — opaque, stable for the resource's lifetime.
  id: string
  // Random slug used as the ClusterIP Service name + DNS hostname.
  slug: string
  // Free-form display label.
  name: string
  owner: string
  namespace: string
  // VM slug this LB exposes. The backing pod must be running for
  // traffic to flow; otherwise endpoints stay empty.
  vmSlug: string
  port: number
  hostname: string
  url: string
  status: LoadBalancerStatus
  createdAt: string
}

export type CreateLoadBalancerInput = {
  name: string
  vmSlug: string
  port: number
}

export const LB_LABEL = "agent-platform/component"
export const LB_LABEL_VALUE = "loadbalancer"
export const LB_OWNER_LABEL = "agent-platform/lb-owner"
export const LB_VM_LABEL = "agent-platform/lb-vm"
export const LB_PORT_ANNOTATION = "agent-platform/lb-port"
export const LB_DISPLAY_NAME_ANNOTATION = "agent-platform/lb-display-name"
