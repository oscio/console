// Phase-2 Functions resource. Postgres holds metadata; FGA tuples
// own ACL (owner + optional `user:*` viewer for public); Forgejo
// holds the source-of-truth code repo under org `service`.

export const FUNCTION_RUNTIMES = ["node20", "python3.12"] as const
export type FunctionRuntime = (typeof FUNCTION_RUNTIMES)[number]

export type FunctionStatus = "Draft"

export type Func = {
  id: string
  slug: string
  name: string
  owner: string
  runtime: FunctionRuntime
  status: FunctionStatus
  // FGA-driven: true iff function carries `user:* viewer` tuple.
  public: boolean
  // Web URL into Forgejo, "" when client isn't configured yet.
  forgejoUrl: string
  createdAt: string
}

export type CreateFunctionInput = {
  name: string
  runtime: FunctionRuntime
  // Default false — most functions start private and the owner
  // flips visibility from the detail page when ready.
  public?: boolean
}
