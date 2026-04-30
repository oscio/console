"use client"

import { useState } from "react"

// Click-to-copy id chip. Used for task / session UUIDs that we want
// the user (or me, debugging) to drop into kubectl / api calls.
// `select-all` is kept as a fallback for terminals that don't have
// clipboard access; click also copies and flashes "copied" for 1s.
export function CopyableId({
  id,
  className = "",
}: {
  id: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <code
      role="button"
      title="Click to copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(id)
          setCopied(true)
          setTimeout(() => setCopied(false), 1000)
        } catch {
          // clipboard blocked — `select-all` still works
        }
      }}
      className={`font-mono select-all cursor-pointer hover:opacity-100 ${className}`}
    >
      {copied ? "copied" : id}
    </code>
  )
}
