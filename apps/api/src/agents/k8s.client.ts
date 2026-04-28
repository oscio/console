// Re-export the shared kube clients so this module's imports stay
// scoped to `./k8s.client`. The vms module bootstraps the KubeConfig
// once; nothing here is module-specific.
export { k8sApps, k8sCore, k8sCustom } from "../vms/k8s.client"
