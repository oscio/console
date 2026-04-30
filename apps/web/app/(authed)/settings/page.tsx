import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import { notFound } from "next/navigation"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Input } from "@workspace/ui/components/input"
import { fetchGlobalEnv, fetchMe, setGlobalEnv } from "@/lib/api"

// Cluster-wide env Secret. The set of keys is fixed (RESERVED below)
// because everything here is "platform plumbing" that the codebase
// reads by name — adding an arbitrary key would just sit unused.
// Admins edit the value of each predefined key and Save.

const RESERVED: { key: string }[] = [{ key: "OPENROUTER_API_KEY" }]

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

async function saveAction(formData: FormData) {
  "use server"
  const key = String(formData.get("key") ?? "").trim()
  const value = String(formData.get("value") ?? "")
  if (!key) return
  if (!ENV_NAME_RE.test(key)) return
  const cookieHeader = (await headers()).get("cookie") ?? ""
  await setGlobalEnv(cookieHeader, key, value)
  revalidatePath("/settings")
}

export default async function SettingsPage() {
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const me = await fetchMe(cookieHeader)
  const allowed = (me?.isPlatformAdmin || me?.isConsoleAdmin) ?? false
  if (!allowed) notFound()

  const apiKeys = await fetchGlobalEnv(cookieHeader)
  const valueByKey = new Map(
    (apiKeys ?? []).map((k) => [k.name, k.value] as const),
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-muted-foreground text-sm">
          Cluster-wide configuration. Values are mounted onto every
          agent pod via the{" "}
          <code>agent-platform-global-env</code> Secret. Updates take
          effect on the next pod restart.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Global environment</CardTitle>
          <CardDescription>
            Predefined keys shared by every agent. The key column is
            fixed; edit the value and Save.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {apiKeys === null ? (
            <p
              role="alert"
              className="text-destructive border-destructive/30 bg-destructive/5 border px-3 py-2 text-sm"
            >
              The api refused this request. Check that you still have
              admin role.
            </p>
          ) : (
            RESERVED.map((row) => (
              <Row
                key={row.key}
                keyName={row.key}
                value={valueByKey.get(row.key) ?? ""}
                saveAction={saveAction}
              />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Row({
  keyName,
  value,
  saveAction,
}: {
  keyName: string
  value: string
  saveAction: (formData: FormData) => Promise<void>
}) {
  return (
    <form action={saveAction} className="flex items-center gap-2">
      <Input
        name="key"
        value={keyName}
        readOnly
        className="font-mono"
      />
      <Input
        name="value"
        type="text"
        autoComplete="off"
        defaultValue={value}
        placeholder="value"
      />
      <Button type="submit">Save</Button>
    </form>
  )
}
