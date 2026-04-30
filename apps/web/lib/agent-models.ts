// OpenRouter model catalog. Fetched server-side from
// https://openrouter.ai/api/v1/models so we always reflect what's
// actually routable. Cached for an hour — the catalog churns slowly,
// and we don't want every page-render to round-trip.
//
// Falls back to a small static list when openrouter.ai is unreachable
// (offline dev, NAT issues) so the create modals still render.

export type AgentModel = {
  id: string
  name: string
}

const FALLBACK: AgentModel[] = [
  { id: "anthropic/claude-sonnet-4", name: "anthropic/claude-sonnet-4" },
  { id: "anthropic/claude-sonnet-4.5", name: "anthropic/claude-sonnet-4.5" },
  { id: "anthropic/claude-opus-4", name: "anthropic/claude-opus-4" },
  { id: "anthropic/claude-opus-4.1", name: "anthropic/claude-opus-4.1" },
  { id: "openai/gpt-4o", name: "openai/gpt-4o" },
  { id: "openai/gpt-4o-mini", name: "openai/gpt-4o-mini" },
  { id: "google/gemini-2.0-flash", name: "google/gemini-2.0-flash" },
]

export const DEFAULT_AGENT_MODEL = "anthropic/claude-sonnet-4"

export async function fetchAgentModels(): Promise<AgentModel[]> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      // 1h server-side cache. RSC re-uses this between navigations.
      next: { revalidate: 3600 },
    })
    if (!res.ok) throw new Error(`openrouter ${res.status}`)
    const body = (await res.json()) as { data: { id: string; name?: string }[] }
    if (!Array.isArray(body.data) || body.data.length === 0) return FALLBACK
    return body.data
      .filter((m) => typeof m.id === "string" && m.id.length > 0)
      .map((m) => ({ id: m.id, name: m.name ?? m.id }))
      .sort((a, b) => a.id.localeCompare(b.id))
  } catch {
    return FALLBACK
  }
}
