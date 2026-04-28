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
import { fetchAgents, type Agent, type AgentStatus } from "@/lib/api"
import { ArrowSquareOut, Robot } from "@phosphor-icons/react/dist/ssr"

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

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/agents"
          className="text-muted-foreground hover:text-foreground text-xs"
        >
          ← Back to Agents
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{agent.name}</h1>
          <StatusBadge status={agent.status} />
        </div>
        <p className="text-muted-foreground font-mono text-xs">{agent.slug}</p>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Launch</h2>
        {!isRunning && (
          <p className="text-muted-foreground text-xs">
            Button activates once the agent is Running.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <LaunchCard
            href={agent.gatewayUrl}
            disabled={!isRunning}
            icon={<Robot weight="duotone" className="size-5" />}
            title="Agent Gateway"
            blurb={`The ${agent.agentType} gateway, served on port 8000.`}
          />
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
      <dt className="text-muted-foreground">Hostname</dt>
      <dd className="font-mono text-xs">{agent.hostname}</dd>
      <dt className="text-muted-foreground">Namespace</dt>
      <dd className="font-mono text-xs">{agent.namespace}</dd>
      <dt className="text-muted-foreground">Created</dt>
      <dd>{new Date(agent.createdAt).toLocaleString()}</dd>
    </dl>
  )
}

function LaunchCard({
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
          {!disabled && (
            <ArrowSquareOut
              className="text-muted-foreground group-hover:text-foreground ml-auto size-4 transition-colors"
              weight="bold"
            />
          )}
        </div>
        <CardDescription className="text-xs leading-relaxed">
          {blurb}
        </CardDescription>
      </CardHeader>
    </Card>
  )
  if (disabled) return inner
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {inner}
    </a>
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
