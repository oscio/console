import {
  AppsV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
} from "@kubernetes/client-node"

// Reused across the api process. In-cluster: ServiceAccount token via
// the projected files at /var/run/secrets/kubernetes.io/serviceaccount.
// Local dev: ~/.kube/config (KUBECONFIG honored).
let kc: KubeConfig | null = null

function getKubeConfig(): KubeConfig {
  if (kc) return kc
  kc = new KubeConfig()
  if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster()
  } else {
    kc.loadFromDefault()
  }
  return kc
}

export const k8sCore = (): CoreV1Api => getKubeConfig().makeApiClient(CoreV1Api)
export const k8sApps = (): AppsV1Api => getKubeConfig().makeApiClient(AppsV1Api)
export const k8sCustom = (): CustomObjectsApi =>
  getKubeConfig().makeApiClient(CustomObjectsApi)
