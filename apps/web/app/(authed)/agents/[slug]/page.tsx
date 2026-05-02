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
  fetchAgents,
  renameAgent,
  type Agent,
  type AgentStatus,
} from "@/lib/api"
import { AutoRefresh } from "@/components/auto-refresh"
import { LocalTime } from "@/components/local-time"
import { RenameForm } from "@/components/rename-form"
import { ChatCircle } from "@phosphor-icons/react/dist/ssr"

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const agents = await fetchAgents(cookieHeader)
  if (agents === null) {
    return (
      <p className="text-destructive text-sm">
        Not authenticated against the Agents API.
      </p>
    )
  }
  const agent = agents.find((a) => a.slug === slug)
  if (!agent) notFound()

  const isRunning = agent.status === "Running"
  const pending = agent.status === "Pending" || agent.status === "Unknown"

  async function renameAction(formData: FormData) {
    "use server"
    const newName = String(formData.get("name") ?? "").trim()
    if (!newName) return { error: "name is required" }
    const cookieHeader = (await headers()).get("cookie") ?? ""
    try {
      await renameAgent(cookieHeader, slug, newName)
    } catch (err) {
      return { error: (err as Error).message }
    }
    revalidatePath(`/agents/${slug}`)
    revalidatePath("/agents")
  }

  return (
    <div className="space-y-6">
      <AutoRefresh pending={pending} />
      <div>
        <Link
          href="/agents"
          className="text-muted-foreground hover:text-foreground text-xs"
        >
          ← Back to Agents
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <RenameForm initialName={agent.name} action={renameAction} />
          <StatusBadge status={agent.status} />
        </div>
        <p className="text-muted-foreground font-mono text-xs">{agent.slug}</p>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Open</h2>
        {!isRunning && (
          <p className="text-muted-foreground text-xs">
            Card activates once the agent is Running.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <NavCard
            href={`/agents/${agent.slug}/chat`}
            disabled={!isRunning}
            icon={<ChatCircle weight="duotone" className="size-5" />}
            title="Chat"
            blurb={`Talk to the ${agent.agentType} agent. Sessions persist on the workspace volume.`}
          />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">URLs</h2>
        <div className="space-y-0.5">
          <div className="text-muted-foreground text-xs">
            Internal (cluster-local)
          </div>
          <span
            className={`font-mono text-sm ${
              isRunning ? "" : "text-muted-foreground"
            }`}
          >
            {agent.internalUrl}
          </span>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Details</h2>
        <Card>
          <CardContent>
            <Details agent={agent} />
          </CardContent>
        </Card>
      </section>
    </div>
  )
}

function Details({ agent }: { agent: Agent }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      <dt className="text-muted-foreground">ID</dt>
      <dd className="font-mono">{agent.slug}</dd>
      <dt className="text-muted-foreground">Type</dt>
      <dd>
        <Badge variant="secondary">{agent.agentType}</Badge>
      </dd>
      <dt className="text-muted-foreground">Status</dt>
      <dd>
        <StatusBadge status={agent.status} />
      </dd>
      {agent.boundToVm ? (
        <>
          <dt className="text-muted-foreground">Bound to</dt>
          <dd>
            <Link
              href={`/vms/${agent.boundToVm}`}
              className="font-mono hover:underline"
            >
              {agent.boundToVm}
            </Link>
          </dd>
        </>
      ) : null}
      <dt className="text-muted-foreground">Namespace</dt>
      <dd className="font-mono">{agent.namespace}</dd>
      <dt className="text-muted-foreground">Created</dt>
      <dd><LocalTime iso={agent.createdAt} /></dd>
    </dl>
  )
}

function NavCard({
  href,
  disabled,
  icon,
  title,
  blurb,
}: {
  href: string
  disabled: boolean
  icon: React.ReactNode
  title: string
  blurb: string
}) {
  const inner = (
    <Card
      className={`group transition-colors ${
        disabled
          ? "cursor-not-allowed opacity-50"
          : "hover:border-foreground/30"
      }`}
      aria-disabled={disabled || undefined}
    >
      <CardHeader>
        <div className="flex items-center gap-2">
          {icon}
          <CardTitle className="text-sm">{title}</CardTitle>
        </div>
        <CardDescription className="text-xs leading-relaxed">
          {blurb}
        </CardDescription>
      </CardHeader>
    </Card>
  )
  if (disabled) return inner
  return (
    <Link
      href={href}
      className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {inner}
    </Link>
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
