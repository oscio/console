import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Badge } from "@workspace/ui/components/badge"
import { Card, CardContent } from "@workspace/ui/components/card"
import {
  fetchLoadBalancers,
  renameLoadBalancer,
  type LoadBalancer,
  type LoadBalancerStatus,
} from "@/lib/api"
import { AutoRefresh } from "@/components/auto-refresh"
import { LocalTime } from "@/components/local-time"
import { RenameForm } from "@/components/rename-form"
import { ArrowSquareOut } from "@phosphor-icons/react/dist/ssr"

export default async function LoadBalancerDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const lbs = await fetchLoadBalancers(cookieHeader)
  if (lbs === null) {
    return (
      <p className="text-destructive text-sm">
        Not authenticated against the LoadBalancers API.
      </p>
    )
  }
  const lb = lbs.find((l) => l.slug === slug)
  if (!lb) notFound()

  const pending = lb.status === "Pending" || lb.status === "Unknown"
  const isReady = lb.status === "Ready"

  async function renameAction(formData: FormData) {
    "use server"
    const newName = String(formData.get("name") ?? "").trim()
    if (!newName) return { error: "name is required" }
    const cookieHeader = (await headers()).get("cookie") ?? ""
    try {
      await renameLoadBalancer(cookieHeader, slug, newName)
    } catch (err) {
      return { error: (err as Error).message }
    }
    revalidatePath(`/loadbalancers/${slug}`)
    revalidatePath("/loadbalancers")
  }

  return (
    <div className="space-y-6">
      <AutoRefresh pending={pending} />
      <div>
        <Link
          href="/loadbalancers"
          className="text-muted-foreground hover:text-foreground text-xs"
        >
          ← Back to Load Balancers
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <RenameForm initialName={lb.name} action={renameAction} />
          <StatusBadge status={lb.status} />
        </div>
        <p className="text-muted-foreground font-mono text-xs">{lb.slug}</p>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">URL</h2>
        {!isReady && (
          <p className="text-muted-foreground text-xs">
            URL responds once the target VM has running endpoints.
          </p>
        )}
        <a
          href={lb.url}
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-flex items-center gap-2 font-mono text-sm ${
            isReady ? "hover:underline" : "text-muted-foreground"
          }`}
        >
          {lb.url}
          {isReady && <ArrowSquareOut weight="bold" className="size-4" />}
        </a>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Details</h2>
        <Card>
          <CardContent>
            <Details lb={lb} />
          </CardContent>
        </Card>
      </section>
    </div>
  )
}

function Details({ lb }: { lb: LoadBalancer }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      <dt className="text-muted-foreground">ID</dt>
      <dd className="font-mono">{lb.slug}</dd>
      <dt className="text-muted-foreground">Status</dt>
      <dd>
        <StatusBadge status={lb.status} />
      </dd>
      <dt className="text-muted-foreground">Target VM</dt>
      <dd>
        <Link
          href={`/vms/${lb.vmSlug}`}
          className="font-mono hover:underline"
        >
          {lb.vmSlug}
        </Link>
      </dd>
      <dt className="text-muted-foreground">Target port</dt>
      <dd className="font-mono">{lb.port}</dd>
      <dt className="text-muted-foreground">Hostname</dt>
      <dd className="font-mono">{lb.hostname}</dd>
      <dt className="text-muted-foreground">Namespace</dt>
      <dd className="font-mono">{lb.namespace}</dd>
      <dt className="text-muted-foreground">Created</dt>
      <dd><LocalTime iso={lb.createdAt} /></dd>
    </dl>
  )
}

function StatusBadge({ status }: { status: LoadBalancerStatus }) {
  switch (status) {
    case "Ready":
      return <Badge>{status}</Badge>
    case "Pending":
    case "Unknown":
    default:
      return <Badge variant="outline">{status}</Badge>
  }
}
