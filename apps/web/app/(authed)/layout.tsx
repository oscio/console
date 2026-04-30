import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { auth } from "@workspace/auth"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@workspace/ui/components/sidebar"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { ConsoleSidebar } from "@/components/sidebar/console-sidebar"
import { ThemeToggle } from "@/components/theme-toggle"
import { fetchMe } from "@/lib/api"

export default async function AuthedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const headerStore = await headers()
  const session = await auth.api.getSession({ headers: headerStore })

  if (!session) {
    redirect("/sign-in")
  }

  // /accounts/me is the source of truth for role flags — the
  // better-auth session has the user identity, but admin status
  // comes from Keycloak groups (platform-admin) and OpenFGA tuples
  // (console-admin) which the api combines.
  const me = await fetchMe(headerStore.get("cookie") ?? "").catch(() => null)

  return (
    <TooltipProvider>
      <SidebarProvider>
        <ConsoleSidebar
          user={{
            name: session.user.name,
            email: session.user.email,
            isPlatformAdmin: me?.isPlatformAdmin ?? false,
            isConsoleAdmin: me?.isConsoleAdmin ?? false,
          }}
        />
        <SidebarInset>
          <header className="flex h-12 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            <span className="text-muted-foreground text-sm">Console</span>
            <div className="ml-auto">
              <ThemeToggle />
            </div>
          </header>
          <main className="flex-1 p-6">{children}</main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
