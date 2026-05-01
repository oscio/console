import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Badge } from "@workspace/ui/components/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import {
  fetchFunctions,
  renameFunction,
  setFunctionVisibility,
  type Func,
} from "@/lib/api"
import { LocalTime } from "@/components/local-time"
import { RenameForm } from "@/components/rename-form"
import {
  ArrowSquareOut,
  Code,
  GitBranch,
} from "@phosphor-icons/react/dist/ssr"
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
        <h2 className="text-lg font-semibold">Open</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <ActionCard
            href={`/services/functions/${fn.slug}/edit`}
            kind="internal"
            icon={<Code weight="duotone" className="size-5" />}
            title="Edit"
            blurb="Multi-file Monaco editor for the function/ folder. Save commits straight to the repo."
          />
          {fn.forgejoUrl && (
            <ActionCard
              href={fn.forgejoUrl}
              kind="external"
              icon={<GitBranch weight="duotone" className="size-5" />}
              title="Open in Forgejo"
              blurb="Full repo: Dockerfile, runner, build workflow. Edit via git for power-user changes."
            />
          )}
        </div>
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
      <dt className="text-muted-foreground">Created</dt>
      <dd>
        <LocalTime iso={fn.createdAt} />
      </dd>
    </dl>
  )
}

function ActionCard({
  href,
  kind,
  icon,
  title,
  blurb,
}: {
  href: string
  // Internal NavLink (next/link, same tab) vs external (target=_blank).
  kind: "internal" | "external"
  icon: React.ReactNode
  title: string
  blurb: string
}) {
  const inner = (
    <Card className="group transition-colors hover:border-foreground/30">
      <CardHeader>
        <div className="flex items-center gap-2">
          {icon}
          <CardTitle className="text-sm">{title}</CardTitle>
          <ArrowSquareOut
            className="text-muted-foreground group-hover:text-foreground ml-auto size-4 transition-colors"
            weight="bold"
          />
        </div>
        <CardDescription className="text-xs leading-relaxed">
          {blurb}
        </CardDescription>
      </CardHeader>
    </Card>
  )
  const className =
    "block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-md"
  return kind === "external" ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {inner}
    </a>
  ) : (
    <Link href={href} className={className}>
      {inner}
    </Link>
  )
}
