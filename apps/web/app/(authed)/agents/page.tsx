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
  type AgentStatus,
  type AgentType,
  createAgent,
  deleteAgent,
  fetchAgents,
} from "@/lib/api"
import { fetchAgentModels } from "@/lib/agent-models"
import { AutoRefresh } from "@/components/auto-refresh"
import { DeleteAgentButton, NewAgentForm } from "./new-agent-form"

async function createAgentAction(formData: FormData) {
  "use server"
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const name = String(formData.get("name") ?? "").trim()
  const agentType = String(formData.get("agentType") ?? "zeroclaw") as AgentType
  const modelRaw = String(formData.get("model") ?? "").trim()
  const model = modelRaw.length > 0 ? modelRaw : undefined
  if (!name) return { error: "name is required" }
  try {
    await createAgent(cookieHeader, { name, agentType, model })
  } catch (err) {
    return { error: (err as Error).message }
  }
  revalidatePath("/agents")
}

async function deleteAgentAction(formData: FormData) {
  "use server"
  const slug = String(formData.get("slug") ?? "")
  if (!slug) return
  const cookieHeader = (await headers()).get("cookie") ?? ""
  await deleteAgent(cookieHeader, slug)
  revalidatePath("/agents")
}

export default async function AgentsPage() {
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const [agents, models] = await Promise.all([
    fetchAgents(cookieHeader),
    fetchAgentModels(),
  ])
  const pending = (agents ?? []).some(
    (a) => a.status === "Pending" || a.status === "Unknown",
  )

  return (
    <div className="space-y-6">
      <AutoRefresh pending={pending} />
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Agents</h1>
          <p className="text-muted-foreground text-sm">
            Single-purpose pods running an agent gateway, scoped to your
            account.
          </p>
        </div>
        {agents !== null && (
          <NewAgentForm action={createAgentAction} models={models} />
        )}
      </div>

      {agents === null ? (
        <p className="text-destructive text-sm">
          Not authenticated against the Agents API.
        </p>
      ) : (
        <div className="overflow-hidden border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Bound to</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((agent) => (
                <TableRow key={agent.id}>
                  <TableCell>
                    <Link
                      href={`/agents/${agent.slug}`}
                      className="hover:underline"
                    >
                      {agent.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {agent.slug}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{agent.agentType}</Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {agent.boundToVm ? (
                      <Link
                        href={`/vms/${agent.boundToVm}`}
                        className="font-mono hover:underline"
                      >
                        {agent.boundToVm}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={agent.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {new Date(agent.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/agents/${agent.slug}`}>Open</Link>
                      </Button>
                      <DeleteAgentButton
                        action={deleteAgentAction}
                        slug={agent.slug}
                        label={agent.name}
                        disabled={!!agent.boundToVm}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {agents.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-muted-foreground py-6 text-center"
                  >
                    No agents yet.
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

function StatusBadge({ status }: { status: AgentStatus }) {
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
