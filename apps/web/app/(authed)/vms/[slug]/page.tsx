import { headers } from "next/headers"
import Link from "next/link"
import { notFound } from "next/navigation"
import { fetchVms, type Vm } from "@/lib/api"
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

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/vms"
          className="text-muted-foreground hover:text-foreground text-xs"
        >
          ← Back to VMs
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{vm.name}</h1>
        <p className="text-muted-foreground text-xs font-mono">{vm.slug}</p>
      </div>

      <Section title="Launch">
        {!isRunning && (
          <p className="text-muted-foreground mb-3 text-xs">
            Status is {vm.status}. Buttons activate once the VM is Running.
          </p>
        )}
        <div className="flex flex-wrap gap-3">
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
      </Section>

      <Section title="Details">
        <Details vm={vm} />
      </Section>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="bg-card text-card-foreground rounded-md border p-4">
        {children}
      </div>
    </section>
  )
}

function Details({ vm }: { vm: Vm }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      <dt className="text-muted-foreground">ID</dt>
      <dd className="font-mono">{vm.slug}</dd>
      <dt className="text-muted-foreground">Image</dt>
      <dd>{vm.imageType}</dd>
      <dt className="text-muted-foreground">Agent</dt>
      <dd>{vm.agentType}</dd>
      <dt className="text-muted-foreground">Status</dt>
      <dd>{vm.status}</dd>
      <dt className="text-muted-foreground">Hostname</dt>
      <dd className="font-mono text-xs">{vm.hostname}</dd>
      <dt className="text-muted-foreground">Namespace</dt>
      <dd className="font-mono text-xs">{vm.namespace}</dd>
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
  const className =
    "group bg-background hover:border-foreground/30 flex w-64 flex-col gap-2 rounded-md border p-4 text-left transition-colors"
  const inner = (
    <>
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-sm font-medium">{title}</span>
        {!disabled && (
          <ArrowSquareOut
            className="text-muted-foreground group-hover:text-foreground ml-auto size-4 transition-colors"
            weight="bold"
          />
        )}
      </div>
      <p className="text-muted-foreground text-xs leading-relaxed">{blurb}</p>
    </>
  )
  if (disabled) {
    return (
      <div className={`${className} cursor-not-allowed opacity-50`} aria-disabled="true">
        {inner}
      </div>
    )
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {inner}
    </a>
  )
}
