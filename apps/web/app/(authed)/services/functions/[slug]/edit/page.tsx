import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import Link from "next/link"
import { notFound } from "next/navigation"
import {
  deployFunction,
  fetchFunctionFiles,
  fetchFunctionRuntime,
  fetchFunctions,
  invokeFunction,
  lifecycleFor,
  saveFunctionFiles,
} from "@/lib/api"
import { CodeEditor } from "../code-editor"
import { EditTestTabs } from "./edit-test-tabs"
import { TestPanel, type InvocationResult } from "./test-panel"

export default async function FunctionEditPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const cookieHeader = (await headers()).get("cookie") ?? ""

  const fns = await fetchFunctions(cookieHeader)
  if (fns === null) {
    return (
      <p className="text-destructive text-sm">
        Not authenticated against the Functions API.
      </p>
    )
  }
  const fn = fns.find((f) => f.slug === slug)
  if (!fn) notFound()

  const [filesData, runtime] = await Promise.all([
    fetchFunctionFiles(cookieHeader, slug).catch((err: Error) => ({
      error: err.message,
    })),
    fetchFunctionRuntime(cookieHeader, slug).catch(() => null),
  ])
  const lifecycle = runtime ? lifecycleFor(runtime) : "unknown"

  async function saveFilesAction(input: {
    files: { path: string; content: string }[]
    deletes: string[]
  }) {
    "use server"
    const cookieHeader = (await headers()).get("cookie") ?? ""
    try {
      await saveFunctionFiles(cookieHeader, slug, input)
    } catch (err) {
      return { error: (err as Error).message }
    }
    revalidatePath(`/services/functions/${slug}/edit`)
    revalidatePath(`/services/functions/${slug}`)
  }

  async function deployAction() {
    "use server"
    const cookieHeader = (await headers()).get("cookie") ?? ""
    try {
      await deployFunction(cookieHeader, slug)
    } catch (err) {
      return { error: (err as Error).message }
    }
    revalidatePath(`/services/functions/${slug}/edit`)
    revalidatePath(`/services/functions/${slug}`)
  }

  async function invokeAction(input: {
    method: string
    path: string
    headers: Record<string, string>
    body: string
  }): Promise<{ result?: InvocationResult; error?: string }> {
    "use server"
    const cookieHeader = (await headers()).get("cookie") ?? ""
    try {
      const result = await invokeFunction(cookieHeader, slug, input)
      return { result }
    } catch (err) {
      return { error: (err as Error).message }
    }
  }

  const filesError = "error" in filesData ? filesData.error : null
  const filesPayload = "error" in filesData ? null : filesData

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="shrink-0">
        <Link
          href={`/services/functions/${slug}`}
          className="text-muted-foreground hover:text-foreground text-xs"
        >
          ← Back to {fn.name}
        </Link>
      </div>

      <div className="min-h-0 flex-1">
        <EditTestTabs
          edit={
            filesPayload ? (
              <CodeEditor
                initialFiles={filesPayload.files}
                defaultFile={filesPayload.defaultFile}
                fallbackLanguage={filesPayload.language}
                rootFolder={filesPayload.folder}
                saveAction={saveFilesAction}
                deployAction={deployAction}
                lifecycle={lifecycle}
                height="100%"
              />
            ) : (
              <p className="text-destructive text-sm">
                Couldn't load files: {filesError ?? "unknown error"}
              </p>
            )
          }
          test={<TestPanel invokeAction={invokeAction} />}
        />
      </div>
    </div>
  )
}
