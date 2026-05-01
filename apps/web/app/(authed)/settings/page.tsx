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
import {
  fetchBranding,
  fetchGlobalEnv,
  fetchMe,
  saveBranding,
  setGlobalEnv,
} from "@/lib/api"

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

async function saveBrandingAction(formData: FormData) {
  "use server"
  const cookieHeader = (await headers()).get("cookie") ?? ""
  await saveBranding(cookieHeader, {
    color: String(formData.get("color") ?? "").trim(),
    textColor: String(formData.get("textColor") ?? "").trim(),
    imageUrl: String(formData.get("imageUrl") ?? "").trim(),
    title: String(formData.get("title") ?? "").trim() || "Console",
    description: String(formData.get("description") ?? "").trim(),
  })
  revalidatePath("/settings")
  revalidatePath("/sign-in")
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
  const branding = await fetchBranding(cookieHeader).catch(() => ({
    color: "",
    textColor: "",
    imageUrl: "",
    title: "Console",
    description: "",
  }))

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

      <Card>
        <CardHeader>
          <CardTitle>Sign-in branding</CardTitle>
          <CardDescription>
            Aside panel of the sign-in page. Image takes precedence
            over color when both are set; the image is cropped (ratio
            preserved) to fill the panel. Description is hidden on
            mobile.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={saveBrandingAction} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="branding-title" className="text-sm font-medium">
                Title
              </label>
              <Input
                id="branding-title"
                name="title"
                defaultValue={branding.title}
                placeholder="Console"
                maxLength={60}
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="branding-description"
                className="text-sm font-medium"
              >
                Description
              </label>
              <Input
                id="branding-description"
                name="description"
                defaultValue={branding.description}
                placeholder="Short subtitle (optional)"
                maxLength={200}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="branding-color" className="text-sm font-medium">
                Background color
              </label>
              <Input
                id="branding-color"
                name="color"
                defaultValue={branding.color}
                placeholder="#0f0f11"
                pattern="^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$"
              />
              <p className="text-muted-foreground text-xs">
                Hex like <code>#0f0f11</code>. Default is dark
                regardless of the page theme.
              </p>
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="branding-text-color"
                className="text-sm font-medium"
              >
                Text color
              </label>
              <Input
                id="branding-text-color"
                name="textColor"
                defaultValue={branding.textColor}
                placeholder="#ffffff"
                pattern="^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$"
              />
              <p className="text-muted-foreground text-xs">
                Hex for the title / description. Defaults to
                <code> #ffffff</code>.
              </p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="branding-image" className="text-sm font-medium">
                Background image URL
              </label>
              <Input
                id="branding-image"
                name="imageUrl"
                type="url"
                defaultValue={branding.imageUrl}
                placeholder="https://…"
              />
              <p className="text-muted-foreground text-xs">
                Public URL. Image is cropped (ratio preserved) to
                fill the panel. Leave blank to use the color.
              </p>
            </div>
            <Button type="submit">Save</Button>
          </form>
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
