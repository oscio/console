"use client"

import * as React from "react"
import { Moon, Sun, Monitor } from "@phosphor-icons/react"
import { useTheme } from "next-themes"
import { Button } from "@workspace/ui/components/button"

// Three-mode cycle: light → dark → system → light. We track the
// user's *chosen* theme (`theme`) rather than `resolvedTheme` so the
// system mode stays sticky — `resolvedTheme` collapses to light/dark
// based on prefers-color-scheme and would lose the "follow OS"
// signal otherwise.
const ORDER = ["light", "dark", "system"] as const
type Mode = (typeof ORDER)[number]

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  const current: Mode = mounted
    ? ORDER.includes(theme as Mode)
      ? (theme as Mode)
      : "system"
    : "system"

  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]!

  const Icon =
    current === "light" ? Sun : current === "dark" ? Moon : Monitor

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Theme: ${current} (click for ${next})`}
      title={`Theme: ${current}`}
      onClick={() => setTheme(next)}
    >
      {mounted ? <Icon className="size-4" /> : <Monitor className="size-4" />}
    </Button>
  )
}
