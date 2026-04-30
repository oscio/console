"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Database,
  Gauge,
  IdentificationCard,
  Network,
  Robot,
  Stack,
  GearSix,
  SignOut,
} from "@phosphor-icons/react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar"
import { signOut } from "@/lib/auth-client"

type NavItem = {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const PRIMARY: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: Gauge },
  { href: "/accounts", label: "Accounts", icon: IdentificationCard },
]

const RESOURCES: NavItem[] = [
  { href: "/vms", label: "VMs", icon: Stack },
  { href: "/volumes", label: "Volumes", icon: Database },
  { href: "/loadbalancers", label: "Load Balancers", icon: Network },
  { href: "/agents", label: "Agents", icon: Robot },
]

const SETTINGS_ITEM: NavItem = {
  href: "/settings",
  label: "Settings",
  icon: GearSix,
}

export function ConsoleSidebar({
  user,
}: {
  user: {
    name: string | null
    email: string
    // Either flag is enough to surface /settings — both roles can
    // read + write global env. Layout passes these through from
    // fetchMe() so a regular user never sees the entry.
    isPlatformAdmin?: boolean
    isConsoleAdmin?: boolean
  }
}) {
  const pathname = usePathname()
  const isAdmin = !!(user.isPlatformAdmin || user.isConsoleAdmin)
  const footerItems: NavItem[] = isAdmin ? [SETTINGS_ITEM] : []

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <div className="bg-sidebar-primary text-sidebar-primary-foreground flex size-8 items-center justify-center rounded-md text-sm font-semibold">
            C
          </div>
          <div className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate text-sm font-semibold">Console</span>
            <span className="text-muted-foreground truncate text-xs">
              Agent Platform
            </span>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Overview</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {PRIMARY.map((item) => (
                <NavLink key={item.href} item={item} pathname={pathname} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Resources</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {RESOURCES.map((item) => (
                <NavLink key={item.href} item={item} pathname={pathname} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          {footerItems.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} />
          ))}
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Sign out"
              onClick={() =>
                signOut({
                  fetchOptions: {
                    onSuccess: () => {
                      window.location.href = "/sign-in"
                    },
                  },
                })
              }
            >
              <SignOut className="size-4" />
              <span>Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="px-2 py-1.5 text-xs leading-tight group-data-[collapsible=icon]:hidden">
          <div className="truncate font-medium">{user.name ?? user.email}</div>
          <div className="text-muted-foreground truncate">{user.email}</div>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
  const Icon = item.icon
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
        <Link href={item.href}>
          <Icon className="size-4" />
          <span>{item.label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
