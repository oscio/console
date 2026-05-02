// Phase-2 Functions resource. Postgres holds metadata; FGA tracks
// console-side ownership; Forgejo holds the code repo under
// org `service`. The `exposed` column controls whether a public
// HTTPRoute is wired up (no auth — anyone with the URL can call).

export const FUNCTION_RUNTIMES = ["python3.12"] as const
export type FunctionRuntime = (typeof FUNCTION_RUNTIMES)[number]

export type Func = {
  id: string
  slug: string
  name: string
  owner: string
  runtime: FunctionRuntime
  // Whether the function is reachable at <slug>.fn.<domain> from
  // outside the cluster. Off by default; toggled by the owner from
  // the detail page. No auth — public means literally public.
  exposed: boolean
  // The hostname Knative + Traefik route to. Always populated (even
  // when not exposed) so the UI can show the "would-be" address.
  hostname: string
  // Full https URL when `exposed`, otherwise empty string.
  exposedUrl: string
  // Cluster-local URL — always reachable from inside the cluster
  // after Deploy (no Expose needed). Empty string before Deploy,
  // since there's no prod Knative Service yet.
  internalUrl: string
  // Kubernetes namespace this function's resources live in. Constant
  // ("resource") today, exposed for parity with VM/LB detail pages.
  namespace: string
  // Web URL into Forgejo, "" when client isn't configured yet.
  forgejoUrl: string
  createdAt: string
}

export type CreateFunctionInput = {
  name: string
  runtime: FunctionRuntime
}
