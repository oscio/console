import { headers } from "next/headers"
import { fetchMe } from "@/lib/api"

export default async function DashboardPage() {
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const me = await fetchMe(cookieHeader)

  return (
    <div className="space-y-1">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="text-muted-foreground text-sm">
        Welcome back, {me?.name ?? me?.email ?? "there"}.
      </p>
    </div>
  )
}
