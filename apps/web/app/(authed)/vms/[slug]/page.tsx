import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Badge } from "@workspace/ui/components/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { fetchVms, renameVm, type Vm, type VmStatus } from "@/lib/api"
import { AutoRefresh } from "@/components/auto-refresh"
import { RenameForm } from "@/components/rename-form"
import {
  ArrowSquareOut,
  Cube,
  Desktop,
  Terminal,
} from "@phosphor-icons/react/dist/ssr"

export default async function VmDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const vms = await fetchVms(cookieHeader)
  if (vms === null) {
    return (
      <p className="text-destructive text-sm">
        Not authenticated against the VMs API.
      </p>
    )
  }
  const vm = vms.find((v) => v.slug === slug)
  if (!vm) notFound()

  const isRunning = vm.status === "Running"
  const pending = vm.status === "Pending" || vm.status === "Unknown"

  async function renameAction(formData: FormData) {
    "use server"
    const newName = String(formData.get("name") ?? "").trim()
    if (!newName) return { error: "name is required" }
    const cookieHeader = (await headers()).get("cookie") ?? ""
    try {
      await renameVm(cookieHeader, slug, newName)
    } catch (err) {
      return { error: (err as Error).message }
    }
    revalidatePath(`/vms/${slug}`)
    revalidatePath("/vms")
  }

  return (
    <div className="space-y-6">
      <AutoRefresh pending={pending} />
      <div>
        <Link
          href="/vms"
          className="text-muted-foreground hover:text-foreground text-xs"
        >
          ← Back to VMs
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <RenameForm initialName={vm.name} action={renameAction} />
          <StatusBadge status={vm.status} />
        </div>
        <p className="text-muted-foreground font-mono text-xs">{vm.slug}</p>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Launch</h2>
        {!isRunning && (
          <p className="text-muted-foreground text-xs">
            Buttons activate once the VM is Running.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <LaunchCard
            href={vm.codeUrl}
            disabled={!isRunning}
            icon={<Cube weight="duotone" className="size-5" />}
            title="code-server"
            blurb="VS Code in the browser, on this VM."
          />
          <LaunchCard
            href={vm.xtermUrl}
            disabled={!isRunning}
            icon={<Terminal weight="duotone" className="size-5" />}
            title="xterm"
            blurb="Web terminal (ttyd) into a bash shell."
          />
          {vm.vncUrl && (
            <LaunchCard
              href={vm.vncUrl}
              disabled={!isRunning}
              icon={<Desktop weight="duotone" className="size-5" />}
              title="VNC"
              blurb="Full XFCE desktop via KasmVNC."
            />
          )}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Details</h2>
        <Card>
          <CardContent>
            <Details vm={vm} />
          </CardContent>
        </Card>
      </section>
    </div>
  )
}

function Details({ vm }: { vm: Vm }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      <dt className="text-muted-foreground">ID</dt>
      <dd className="font-mono">{vm.slug}</dd>
      <dt className="text-muted-foreground">Image</dt>
      <dd>
        <Badge variant="secondary">{vm.imageType}</Badge>
      </dd>
      <dt className="text-muted-foreground">Status</dt>
      <dd>
        <StatusBadge status={vm.status} />
      </dd>
      <dt className="text-muted-foreground">Namespace</dt>
      <dd className="font-mono">{vm.namespace}</dd>
      <dt className="text-muted-foreground">Created</dt>
      <dd>{new Date(vm.createdAt).toLocaleString()}</dd>
    </dl>
  )
}

function LaunchCard({
  href,
  disabled,
  icon,
  title,
  blurb,
}: {
  href: string
  disabled: boolean
  icon: React.ReactNode
  title: string
  blurb: string
}) {
  const inner = (
    <Card
      className={`group transition-colors ${
        disabled
          ? "cursor-not-allowed opacity-50"
          : "hover:border-foreground/30"
      }`}
      aria-disabled={disabled || undefined}
    >
      <CardHeader>
        <div className="flex items-center gap-2">
          {icon}
          <CardTitle className="text-sm">{title}</CardTitle>
          {!disabled && (
            <ArrowSquareOut
              className="text-muted-foreground group-hover:text-foreground ml-auto size-4 transition-colors"
              weight="bold"
            />
          )}
        </div>
        <CardDescription className="text-xs leading-relaxed">
          {blurb}
        </CardDescription>
      </CardHeader>
    </Card>
  )
  if (disabled) return inner
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-md"
    >
      {inner}
    </a>
  )
}

function StatusBadge({ status }: { status: VmStatus }) {
  switch (status) {
    case "Running":
      return <Badge>{status}</Badge>
    case "Failed":
      return <Badge variant="destructive">{status}</Badge>
    case "Pending":
    case "Unknown":
    default:
      return <Badge variant="outline">{status}</Badge>
  }
}
