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
  createLoadBalancer,
  deleteLoadBalancer,
  fetchLoadBalancers,
  fetchVms,
  type LoadBalancerStatus,
} from "@/lib/api"
import {
  DeleteLoadBalancerButton,
  NewLoadBalancerForm,
} from "./new-lb-form"

async function createAction(formData: FormData) {
  "use server"
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const name = String(formData.get("name") ?? "").trim()
  const vmSlug = String(formData.get("vmSlug") ?? "").trim()
  const port = Number(formData.get("port") ?? 0)
  if (!name) return { error: "name is required" }
  if (!vmSlug) return { error: "VM is required" }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: "port must be an integer 1-65535" }
  }
  const persistOnVmDelete = formData.get("persistOnVmDelete") === "true"
  try {
    await createLoadBalancer(cookieHeader, {
      name,
      vmSlug,
      port,
      persistOnVmDelete,
    })
  } catch (err) {
    return { error: (err as Error).message }
  }
  revalidatePath("/loadbalancers")
}

async function deleteAction(formData: FormData) {
  "use server"
  const slug = String(formData.get("slug") ?? "")
  if (!slug) return
  const cookieHeader = (await headers()).get("cookie") ?? ""
  await deleteLoadBalancer(cookieHeader, slug)
  revalidatePath("/loadbalancers")
}

export default async function LoadBalancersPage() {
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const [lbs, vms] = await Promise.all([
    fetchLoadBalancers(cookieHeader),
    fetchVms(cookieHeader),
  ])

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Load Balancers</h1>
          <p className="text-muted-foreground text-sm">
            Expose a VM port at <code>&lt;slug&gt;.lb.{"<"}domain{">"}</code>{" "}
            via Traefik.
          </p>
        </div>
        {lbs !== null && (
          <NewLoadBalancerForm action={createAction} vms={vms ?? []} />
        )}
      </div>

      {lbs === null ? (
        <p className="text-destructive text-sm">
          Not authenticated against the LoadBalancers API.
        </p>
      ) : (
        <div className="overflow-hidden border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>VM</TableHead>
                <TableHead>Port</TableHead>
                <TableHead>URL</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lbs.map((lb) => (
                <TableRow key={lb.id}>
                  <TableCell>{lb.name}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {lb.slug}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/vms/${lb.vmSlug}`}
                      className="font-mono text-xs hover:underline"
                    >
                      {lb.vmSlug}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{lb.port}</TableCell>
                  <TableCell>
                    <a
                      href={lb.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-xs hover:underline"
                    >
                      {lb.hostname}
                    </a>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={lb.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {new Date(lb.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <DeleteLoadBalancerButton
                      action={deleteAction}
                      slug={lb.slug}
                      label={lb.name}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {lbs.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="text-muted-foreground py-6 text-center"
                  >
                    No load balancers yet.
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

function StatusBadge({ status }: { status: LoadBalancerStatus }) {
  switch (status) {
    case "Ready":
      return <Badge>{status}</Badge>
    case "Pending":
      return <Badge variant="outline">{status}</Badge>
    default:
      return <Badge variant="outline">{status}</Badge>
  }
}
