import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import {
  createVm,
  deleteVm,
  fetchVms,
  type VmAgentType,
  type VmImageType,
} from "@/lib/api"
import { DeleteVmButton, NewVmForm } from "./new-vm-form"

async function createVmAction(formData: FormData) {
  "use server"
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const name = String(formData.get("name") ?? "").trim()
  const imageType = String(formData.get("imageType") ?? "base") as VmImageType
  const agentType = String(formData.get("agentType") ?? "hermes") as VmAgentType
  const storageSize = String(formData.get("storageSize") ?? "10Gi").trim()
  if (!name) return { error: "name is required" }
  try {
    await createVm(cookieHeader, { name, imageType, agentType, storageSize })
  } catch (err) {
    return { error: (err as Error).message }
  }
  revalidatePath("/vms")
}

async function deleteVmAction(formData: FormData) {
  "use server"
  const name = String(formData.get("name") ?? "")
  if (!name) return
  const cookieHeader = (await headers()).get("cookie") ?? ""
  await deleteVm(cookieHeader, name)
  revalidatePath("/vms")
}

export default async function VmsPage() {
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const vms = await fetchVms(cookieHeader)

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">VMs</h1>
          <p className="text-muted-foreground text-sm">
            Workspace pods scoped to your account, served by the K8s API.
          </p>
        </div>
        {vms !== null && <NewVmForm action={createVmAction} />}
      </div>

      {vms === null ? (
        <p className="text-destructive text-sm">
          Not authenticated against the VMs API.
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Image</th>
                <th className="px-3 py-2 font-medium">Agent</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Hostname</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {vms.map((vm) => (
                <tr key={vm.id} className="hover:bg-muted/20">
                  <td className="px-3 py-2 font-mono text-xs">{vm.name}</td>
                  <td className="px-3 py-2"><Tag>{vm.imageType}</Tag></td>
                  <td className="px-3 py-2"><Tag>{vm.agentType}</Tag></td>
                  <td className="px-3 py-2">
                    <StatusBadge status={vm.status} />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{vm.hostname}</td>
                  <td className="text-muted-foreground px-3 py-2 text-xs">
                    {new Date(vm.createdAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <DeleteVmButton action={deleteVmAction} name={vm.name} />
                  </td>
                </tr>
              ))}
              {vms.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="text-muted-foreground px-3 py-6 text-center"
                  >
                    No VMs yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium">
      {children}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "Running"
      ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
      : status === "Failed"
        ? "border-red-500/40 text-red-600 dark:text-red-400"
        : status === "Pending"
          ? "border-amber-500/40 text-amber-600 dark:text-amber-400"
          : "text-muted-foreground"
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {status}
    </span>
  )
}
