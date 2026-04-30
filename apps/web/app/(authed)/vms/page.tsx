import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import Link from "next/link"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import {
  createVm,
  deleteVm,
  fetchVms,
  fetchVolumes,
  type VmAgentType,
  type VmImageType,
  type VmStatus,
  type VmVolumeMode,
} from "@/lib/api"
import { fetchAgentModels } from "@/lib/agent-models"
import { AutoRefresh } from "@/components/auto-refresh"
import { DeleteVmButton, NewVmForm } from "./new-vm-form"

async function createVmAction(formData: FormData) {
  "use server"
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const name = String(formData.get("name") ?? "").trim()
  const imageType = String(formData.get("imageType") ?? "base") as VmImageType
  const agentType = String(formData.get("agentType") ?? "none") as VmAgentType
  const cpuRequest = String(formData.get("cpuRequest") ?? "").trim() || undefined
  const memoryRequest = String(formData.get("memoryRequest") ?? "").trim() || undefined
  const volumeMode = String(formData.get("volumeMode") ?? "new") as VmVolumeMode
  const volumeSizeGiRaw = String(formData.get("volumeSizeGi") ?? "")
  const volumeSizeGi = volumeSizeGiRaw ? Number(volumeSizeGiRaw) : undefined
  const persistVolumeOnDelete = formData.get("persistVolumeOnDelete") === "true"
  const volumeSlug = String(formData.get("volumeSlug") ?? "").trim() || undefined
  const lbsRaw = String(formData.get("loadBalancers") ?? "[]")
  let loadBalancers: Array<{
    name?: string
    port: number
  }> = []
  try {
    const parsed = JSON.parse(lbsRaw) as unknown
    if (Array.isArray(parsed)) {
      for (const it of parsed) {
        const obj = it as Record<string, unknown>
        const port = Number(obj.port)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return { error: "load balancer port must be an integer 1-65535" }
        }
        loadBalancers.push({
          name: typeof obj.name === "string" && obj.name.trim()
            ? obj.name.trim()
            : undefined,
          port,
        })
      }
    }
  } catch {
    return { error: "invalid load balancers payload" }
  }
  const agentModelRaw = String(formData.get("agentModel") ?? "").trim()
  const agentModel =
    agentType === "zeroclaw" && agentModelRaw.length > 0
      ? agentModelRaw
      : undefined
  if (!name) return { error: "name is required" }
  try {
    await createVm(cookieHeader, {
      name,
      imageType,
      agentType,
      cpuRequest,
      memoryRequest,
      volumeMode,
      volumeSizeGi,
      persistVolumeOnDelete,
      volumeSlug,
      loadBalancers: loadBalancers.length ? loadBalancers : undefined,
      agentModel,
    })
  } catch (err) {
    return { error: (err as Error).message }
  }
  revalidatePath("/vms")
  revalidatePath("/volumes")
  revalidatePath("/loadbalancers")
}

async function deleteVmAction(formData: FormData) {
  "use server"
  const slug = String(formData.get("slug") ?? "")
  if (!slug) return
  const cookieHeader = (await headers()).get("cookie") ?? ""
  await deleteVm(cookieHeader, slug)
  revalidatePath("/vms")
  revalidatePath("/volumes")
  revalidatePath("/loadbalancers")
}

export default async function VmsPage() {
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const [vms, volumes, models] = await Promise.all([
    fetchVms(cookieHeader),
    fetchVolumes(cookieHeader),
    fetchAgentModels(),
  ])
  const freeVolumes = (volumes ?? []).filter((v) => !v.boundTo)

  return (
    <div className="space-y-6">
      <AutoRefresh />
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">VMs</h1>
          <p className="text-muted-foreground text-sm">
            Workspace pods scoped to your account, served by the K8s API.
          </p>
        </div>
        {vms !== null && (
          <NewVmForm
            action={createVmAction}
            freeVolumes={freeVolumes}
            models={models}
          />
        )}
      </div>

      {vms === null ? (
        <p className="text-destructive text-sm">
          Not authenticated against the VMs API.
        </p>
      ) : (
        <div className="overflow-hidden border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Image</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vms.map((vm) => (
                <TableRow key={vm.id}>
                  <TableCell>
                    <Link href={`/vms/${vm.slug}`} className="hover:underline">
                      {vm.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {vm.slug}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{vm.imageType}</Badge>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={vm.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {new Date(vm.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/vms/${vm.slug}`}>Open</Link>
                      </Button>
                      <DeleteVmButton
                        action={deleteVmAction}
                        slug={vm.slug}
                        label={vm.name}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {vms.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-muted-foreground py-6 text-center"
                  >
                    No VMs yet.
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

function StatusBadge({ status }: { status: VmStatus }) {
  // Map VM lifecycle states to shadcn Badge variants. `Running` reuses
  // the success-leaning default; everything else falls back to the
  // muted variants so the table stays calm.
  switch (status) {
    case "Running":
      return <Badge>{status}</Badge>
    case "Failed":
      return <Badge variant="destructive">{status}</Badge>
    case "Pending":
    case "Unknown":
    default:
      return <Badge variant="outline">{status}</Badge>
  }
}
