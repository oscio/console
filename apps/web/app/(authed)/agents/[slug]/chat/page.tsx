import { headers } from "next/headers"
import Link from "next/link"
import { notFound } from "next/navigation"
import {
  createAgentSession,
  fetchAgents,
  listAgentSessions,
} from "@/lib/api"
import { ChatView } from "./chat-view"

export default async function AgentChatPage({
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

  // Auto-create the first session on first visit. The wrapper itself
  // is happy to host many sessions per pod; we surface a simple "one
  // session per visit unless overridden" model for now and add a
  // session switcher in a follow-up.
  let sessions = await listAgentSessions(cookieHeader, slug).catch(
    () => [],
  )
  if (sessions.length === 0) {
    const created = await createAgentSession(cookieHeader, slug, {
      name: "default",
    })
    sessions = [created]
  }
  const sessionId = sessions[0]!.session_id

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-4">
      <div>
        <Link
          href={`/agents/${slug}`}
          className="text-muted-foreground hover:text-foreground text-xs"
        >
          ← Back to {agent.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Chat</h1>
        <p className="text-muted-foreground text-xs">
          {agent.agentType} · session{" "}
          <code className="font-mono">{sessionId.slice(0, 8)}…</code>
        </p>
      </div>

      <ChatView slug={slug} sessionId={sessionId} />
    </div>
  )
}
