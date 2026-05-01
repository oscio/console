import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Badge } from "@workspace/ui/components/badge"
import { Card, CardContent } from "@workspace/ui/components/card"
import {
  fetchFunctionFiles,
  fetchFunctions,
  renameFunction,
  saveFunctionFiles,
  setFunctionVisibility,
  type Func,
} from "@/lib/api"
import { LocalTime } from "@/components/local-time"
import { RenameForm } from "@/components/rename-form"
import { CodeEditor } from "./code-editor"
import { VisibilityToggle } from "../visibility-toggle"

export default async function FunctionDetailPage({
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

  // Pulling the editable files in parallel with the function row
  // would be nice, but we need to confirm the function exists + is
  // accessible first to avoid leaking 404 vs 403 distinctions to the
  // unauthorised caller.
  let filesData: Awaited<ReturnType<typeof fetchFunctionFiles>> | null = null
  let codeError: string | null = null
  try {
    filesData = await fetchFunctionFiles(cookieHeader, slug)
  } catch (err) {
    codeError = (err as Error).message
  }

  async function renameAction(formData: FormData) {
    "use server"
    const newName = String(formData.get("name") ?? "").trim()
    if (!newName) return { error: "name is required" }
    const cookieHeader = (await headers()).get("cookie") ?? ""
    try {
      await renameFunction(cookieHeader, slug, newName)
    } catch (err) {
      return { error: (err as Error).message }
    }
    revalidatePath(`/services/functions/${slug}`)
    revalidatePath("/services/functions")
  }

  async function visibilityAction(isPublic: boolean) {
    "use server"
    const cookieHeader = (await headers()).get("cookie") ?? ""
    await setFunctionVisibility(cookieHeader, slug, isPublic)
    revalidatePath(`/services/functions/${slug}`)
    revalidatePath("/services/functions")
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
    revalidatePath(`/services/functions/${slug}`)
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/services/functions"
          className="text-muted-foreground hover:text-foreground text-xs"
        >
          ← Back to Functions
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <RenameForm initialName={fn.name} action={renameAction} />
          <Badge variant={fn.public ? "default" : "outline"}>
            {fn.public ? "Public" : "Private"}
          </Badge>
        </div>
        <p className="text-muted-foreground font-mono text-xs">{fn.slug}</p>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Code</h2>
        {filesData ? (
          <CodeEditor
            initialFiles={filesData.files}
            defaultFile={filesData.defaultFile}
            fallbackLanguage={filesData.language}
            saveAction={saveFilesAction}
          />
        ) : (
          <p className="text-destructive text-sm">
            Couldn't load files: {codeError ?? "unknown error"}
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          Editing the {filesData?.folder ?? "user"}/ folder. Dockerfile,
          runner, and Forgejo Actions workflow live in the repo only —
          clone via Forgejo to edit them.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Details</h2>
        <Card>
          <CardContent>
            <Details
              fn={fn}
              visibilityToggle={
                <VisibilityToggle
                  initial={fn.public}
                  action={visibilityAction}
                />
              }
            />
          </CardContent>
        </Card>
      </section>
    </div>
  )
}

function Details({
  fn,
  visibilityToggle,
}: {
  fn: Func
  visibilityToggle: React.ReactNode
}) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      <dt className="text-muted-foreground">ID</dt>
      <dd className="font-mono">{fn.slug}</dd>
      <dt className="text-muted-foreground">Runtime</dt>
      <dd>
        <Badge variant="secondary">{fn.runtime}</Badge>
      </dd>
      <dt className="text-muted-foreground">Visibility</dt>
      <dd>{visibilityToggle}</dd>
      <dt className="text-muted-foreground">Status</dt>
      <dd>
        <Badge variant="outline">{fn.status}</Badge>
      </dd>
      {fn.forgejoUrl && (
        <>
          <dt className="text-muted-foreground">Code</dt>
          <dd>
            <a
              href={fn.forgejoUrl}
              target="_blank"
              rel="noreferrer"
              className="hover:underline"
            >
              Open in Forgejo →
            </a>
          </dd>
        </>
      )}
      <dt className="text-muted-foreground">Created</dt>
      <dd>
        <LocalTime iso={fn.createdAt} />
      </dd>
    </dl>
  )
}
