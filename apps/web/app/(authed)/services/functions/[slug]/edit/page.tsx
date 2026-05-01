import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import Link from "next/link"
import { notFound } from "next/navigation"
import {
  fetchFunctionFiles,
  fetchFunctions,
  saveFunctionFiles,
} from "@/lib/api"
import { CodeEditor } from "../code-editor"

export default async function FunctionEditPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const cookieHeader = (await headers()).get("cookie") ?? ""

  // Existence check — the editor route should 404 the same way the
  // detail page does for unknown slugs, rather than just rendering an
  // empty editor with a fetch error.
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

  let filesData: Awaited<ReturnType<typeof fetchFunctionFiles>> | null = null
  let codeError: string | null = null
  try {
    filesData = await fetchFunctionFiles(cookieHeader, slug)
  } catch (err) {
    codeError = (err as Error).message
  }

  async function saveFilesAction(
    files: { path: string; content: string }[],
  ) {
    "use server"
    const cookieHeader = (await headers()).get("cookie") ?? ""
    try {
      await saveFunctionFiles(cookieHeader, slug, files)
    } catch (err) {
      return { error: (err as Error).message }
    }
    revalidatePath(`/services/functions/${slug}/edit`)
    revalidatePath(`/services/functions/${slug}`)
  }

  return (
    <div className="space-y-3">
      <div>
        <Link
          href={`/services/functions/${slug}`}
          className="text-muted-foreground hover:text-foreground text-xs"
        >
          ← Back to {fn.name}
        </Link>
        <div className="mt-1">
          <h1 className="text-lg font-semibold">{fn.name}</h1>
          <p className="text-muted-foreground font-mono text-xs">
            Editing {filesData?.folder ?? "user"}/ — Dockerfile, runner, and
            workflow live in the repo (clone via Forgejo to edit).
          </p>
        </div>
      </div>

      {filesData ? (
        <CodeEditor
          initialFiles={filesData.files}
          defaultFile={filesData.defaultFile}
          fallbackLanguage={filesData.language}
          saveAction={saveFilesAction}
          height="calc(100vh - 12rem)"
        />
      ) : (
        <p className="text-destructive text-sm">
          Couldn't load files: {codeError ?? "unknown error"}
        </p>
      )}
    </div>
  )
}
