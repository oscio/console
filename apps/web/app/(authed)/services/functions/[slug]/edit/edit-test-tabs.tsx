"use client"

import { useEffect, useState } from "react"

// Lightweight two-tab strip. No need for a generic shadcn Tabs
// component — Edit and Test share a fixed-height parent and we just
// swap which child is rendered. Keeps both children mounted under the
// hood (display:none toggle) so editor state, dirty flags, and Test
// tab request bodies survive tab switches.

export function EditTestTabs({
  edit,
  test,
}: {
  edit: React.ReactNode
  test: React.ReactNode
}) {
  // Persist last-active tab per slug so navigating away and back
  // doesn't reset onto Edit. Local-storage to avoid an extra round
  // trip; harmless if the key disappears.
  const [tab, setTab] = useState<"edit" | "test">("edit")
  useEffect(() => {
    const saved =
      typeof window !== "undefined"
        ? window.localStorage.getItem("functions:lastTab")
        : null
    if (saved === "test") setTab("test")
  }, [])
  function pick(next: "edit" | "test") {
    setTab(next)
    if (typeof window !== "undefined") {
      window.localStorage.setItem("functions:lastTab", next)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b">
        <TabButton active={tab === "edit"} onClick={() => pick("edit")}>
          Edit
        </TabButton>
        <TabButton active={tab === "test"} onClick={() => pick("test")}>
          Test
        </TabButton>
      </div>
      <div className="min-h-0 flex-1 pt-3">
        <div
          className="h-full"
          style={{ display: tab === "edit" ? "block" : "none" }}
        >
          {edit}
        </div>
        <div
          className="h-full"
          style={{ display: tab === "test" ? "block" : "none" }}
        >
          {test}
        </div>
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors ${
        active
          ? "border-foreground text-foreground"
          : "text-muted-foreground hover:text-foreground border-transparent"
      }`}
    >
      {children}
    </button>
  )
}
