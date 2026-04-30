import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Badge } from "@workspace/ui/components/badge"
import { Card, CardContent } from "@workspace/ui/components/card"
import {
  fetchVolumes,
  renameVolume,
  type Volume,
  type VolumeStatus,
} from "@/lib/api"
import { AutoRefresh } from "@/components/auto-refresh"
import { RenameForm } from "@/components/rename-form"

export default async function VolumeDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const volumes = await fetchVolumes(cookieHeader)
  if (volumes === null) {
    return (
      <p className="text-destructive text-sm">
        Not authenticated against the Volumes API.
      </p>
    )
  }
  const volume = volumes.find((v) => v.slug === slug)
  if (!volume) notFound()

  const pending =
    volume.status === "Pending" ||
    volume.status === "Released" ||
    volume.status === "Unknown"

  async function renameAction(formData: FormData) {
    "use server"
    const newName = String(formData.get("name") ?? "").trim()
    if (!newName) return { error: "name is required" }
    const cookieHeader = (await headers()).get("cookie") ?? ""
    try {
      await renameVolume(cookieHeader, slug, newName)
    } catch (err) {
      return { error: (err as Error).message }
    }
    revalidatePath(`/volumes/${slug}`)
    revalidatePath("/volumes")
  }

  return (
    <div className="space-y-6">
      <AutoRefresh pending={pending} />
      <div>
        <Link
          href="/volumes"
          className="text-muted-foreground hover:text-foreground text-xs"
        >
          ← Back to Volumes
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <RenameForm initialName={volume.name} action={renameAction} />
          <StatusBadge status={volume.status} />
        </div>
        <p className="text-muted-foreground font-mono text-xs">{volume.slug}</p>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Details</h2>
        <Card>
          <CardContent>
            <Details volume={volume} />
          </CardContent>
        </Card>
      </section>
    </div>
  )
}

function Details({ volume }: { volume: Volume }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      <dt className="text-muted-foreground">ID</dt>
      <dd className="font-mono">{volume.slug}</dd>
      <dt className="text-muted-foreground">Status</dt>
      <dd>
        <StatusBadge status={volume.status} />
      </dd>
      <dt className="text-muted-foreground">Size</dt>
      <dd>{volume.sizeGi} GiB</dd>
      <dt className="text-muted-foreground">Bound to</dt>
      <dd>
        {volume.boundTo ? (
          <Link
            href={`/vms/${volume.boundTo}`}
            className="font-mono hover:underline"
          >
            {volume.boundTo}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </dd>
      <dt className="text-muted-foreground">Namespace</dt>
      <dd className="font-mono">{volume.namespace}</dd>
      <dt className="text-muted-foreground">Created</dt>
      <dd>{new Date(volume.createdAt).toLocaleString()}</dd>
    </dl>
  )
}

function StatusBadge({ status }: { status: VolumeStatus }) {
  switch (status) {
    case "Available":
      return <Badge variant="outline">{status}</Badge>
    case "Bound":
      return <Badge>{status}</Badge>
    case "Failed":
      return <Badge variant="destructive">{status}</Badge>
    default:
      return <Badge variant="outline">{status}</Badge>
  }
}
