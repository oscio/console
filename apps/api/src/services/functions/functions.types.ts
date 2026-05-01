// Phase-1 Functions resource. Metadata only — no execution runtime
// is wired yet, so the row holds enough to render a list/detail page
// and to attach a runtime later (Knative Service, OpenFaaS Function,
// etc.). Slug is the immutable id; name is the editable display.

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
  createdAt: string
}

export type CreateFunctionInput = {
  name: string
  runtime: FunctionRuntime
}
