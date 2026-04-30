import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import Link from "next/link"
import { Badge } from "@workspace/ui/components/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import {
  createVolume,
  deleteVolume,
  fetchVolumes,
  type VolumeStatus,
} from "@/lib/api"
import { AutoRefresh } from "@/components/auto-refresh"
import { DeleteVolumeButton, NewVolumeForm } from "./new-volume-form"

async function createVolumeAction(formData: FormData) {
  "use server"
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const name = String(formData.get("name") ?? "").trim()
  const sizeGi = Number(formData.get("sizeGi") ?? 1)
  if (!name) return { error: "name is required" }
  if (!Number.isFinite(sizeGi) || sizeGi < 1) {
    return { error: "size must be at least 1 GiB" }
  }
  try {
    await createVolume(cookieHeader, { name, sizeGi })
  } catch (err) {
    return { error: (err as Error).message }
  }
  revalidatePath("/volumes")
}

async function deleteVolumeAction(formData: FormData) {
  "use server"
  const slug = String(formData.get("slug") ?? "")
  if (!slug) return
  const cookieHeader = (await headers()).get("cookie") ?? ""
  await deleteVolume(cookieHeader, slug)
  revalidatePath("/volumes")
}

export default async function VolumesPage() {
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const volumes = await fetchVolumes(cookieHeader)
  const pending = (volumes ?? []).some(
    (v) =>
      v.status === "Pending" ||
      v.status === "Released" ||
      v.status === "Unknown",
  )

  return (
    <div className="space-y-6">
      <AutoRefresh pending={pending} />
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Volumes</h1>
          <p className="text-muted-foreground text-sm">
            PersistentVolumeClaims you own. Attach at VM-create time, or
            persist across VM deletes for re-attach later.
          </p>
        </div>
        {volumes !== null && <NewVolumeForm action={createVolumeAction} />}
      </div>

      {volumes === null ? (
        <p className="text-destructive text-sm">
          Not authenticated against the Volumes API.
        </p>
      ) : (
        <div className="overflow-hidden border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Bound to</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {volumes.map((v) => (
                <TableRow key={v.id}>
                  <TableCell>{v.name}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {v.slug}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{v.sizeGi} GiB</Badge>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={v.status} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {v.boundTo ? (
                      <Link
                        href={`/vms/${v.boundTo}`}
                        className="font-mono hover:underline"
                      >
                        {v.boundTo}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {new Date(v.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <DeleteVolumeButton
                      action={deleteVolumeAction}
                      slug={v.slug}
                      label={v.name}
                      disabled={!!v.boundTo}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {volumes.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-muted-foreground py-6 text-center"
                  >
                    No volumes yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
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
