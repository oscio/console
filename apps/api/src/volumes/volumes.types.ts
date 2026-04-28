export type VolumeStatus = "Available" | "Bound" | "Pending" | "Released" | "Failed" | "Unknown"

export type Volume = {
  // K8s PVC UID — opaque, stable for the resource's lifetime.
  id: string
  // Random slug used as the PVC name. DNS-1035 by construction.
  slug: string
  // Free-form user label.
  name: string
  owner: string
  namespace: string
  status: VolumeStatus
  // Quantity string, e.g. "20Gi". Echoed from spec.resources.requests.storage.
  sizeGi: number
  // Slug of the VM currently using this volume, or null if free.
  boundTo: string | null
  createdAt: string
}

export type CreateVolumeInput = {
  name: string
  sizeGi: number
}

// Labels and annotations used to track volume metadata.
export const VOLUME_LABEL = "agent-platform/component"
export const VOLUME_LABEL_VALUE = "volume"
export const VOLUME_OWNER_LABEL = "agent-platform/volume-owner"
export const VOLUME_BOUND_TO_LABEL = "agent-platform/volume-bound-to"
export const VOLUME_DISPLAY_NAME_ANNOTATION =
  "agent-platform/volume-display-name"

export const VOLUME_DEFAULTS = {
  sizeGi: 1,
} as const
