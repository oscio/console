"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

// Lightweight RSC re-fetch on a fixed interval. Drops onto any
// server-rendered list whose data changes out-of-band (VM/Volume/LB
// status flips Pending→Running). `router.refresh()` invalidates the
// route's RSC cache and re-streams new payload — no full-page
// reload, no client-side state lost.
//
// Pauses when the tab is hidden so background tabs don't spam the
// api.
export function AutoRefresh({ intervalMs = 5000 }: { intervalMs?: number }) {
  const router = useRouter()
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (id) return
      id = setInterval(() => router.refresh(), intervalMs)
    }
    const stop = () => {
      if (!id) return
      clearInterval(id)
      id = null
    }
    const onVis = () => {
      if (document.visibilityState === "visible") start()
      else stop()
    }
    onVis()
    document.addEventListener("visibilitychange", onVis)
    return () => {
      stop()
      document.removeEventListener("visibilitychange", onVis)
    }
  }, [router, intervalMs])
  return null
}
