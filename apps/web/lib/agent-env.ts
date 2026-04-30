import type { AgentType } from "@/lib/api"

// Per-agent-type env-var prompts shown in the create modal. Source
// of truth for both new-agent-form (headless) and new-vm-form (the
// attached-agent section). Adding a new framework = a new entry
// here; the rest of the form is data-driven off of this map.

export type AgentEnvField = {
  // Env var name as the agent CLI / wrapper expects it.
  name: string
  // Short label displayed next to the input.
  label: string
  // One-line hint (placeholder / aria-description). Optional.
  hint?: string
  // True for API keys / secrets — renders <input type="password">.
  secret?: boolean
}

export const AGENT_ENV: Record<AgentType, AgentEnvField[]> = {
  // zeroclaw uses an LLM provider for the agent loop. Anthropic is
  // the most-tested path; users can also drop OPENAI_API_KEY etc.
  // and pass `--provider openai` via config later.
  zeroclaw: [
    {
      name: "ANTHROPIC_API_KEY",
      label: "Anthropic API key",
      hint: "Required by zeroclaw for Claude. Stored in a per-agent k8s Secret.",
      secret: true,
    },
  ],
  // hermes-agent: dispatch by `provider` in its config — typical
  // setups use Anthropic or OpenAI. Surfacing both lets users fill
  // whichever they have without us reading their hermes config.
  hermes: [
    {
      name: "ANTHROPIC_API_KEY",
      label: "Anthropic API key",
      hint: "Used when hermes is configured with the Anthropic provider.",
      secret: true,
    },
    {
      name: "OPENAI_API_KEY",
      label: "OpenAI API key",
      hint: "Used when hermes is configured with the OpenAI provider.",
      secret: true,
    },
  ],
}
