"use client"

import { useEffect, useState } from "react"

// Render an ISO/UTC timestamp in the browser's local timezone.
// `toLocaleString()` reads from `Intl.DateTimeFormat().resolvedOptions().timeZone`
// which on the server is the container's TZ (usually UTC) — so calling it from
// a Server Component would emit UTC into the HTML and every user would see UTC
// regardless of where they are. Doing the format in `useEffect` (client-only)
// uses the user's actual timezone.
//
// During SSR + the first paint we render the raw ISO string; after mount it's
// replaced with the formatted local time. `suppressHydrationWarning` quiets
// React's "server vs client text differs" check that this swap inevitably
// triggers — the difference is intentional.
export function LocalTime({ iso }: { iso: string }) {
  const [text, setText] = useState<string>(iso)
  useEffect(() => {
    try {
      setText(new Date(iso).toLocaleString())
    } catch {
      setText(iso)
    }
  }, [iso])
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {text}
    </time>
  )
}
