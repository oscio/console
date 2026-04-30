import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Put,
  UseGuards,
} from "@nestjs/common"
import { k8sCore } from "../agents/k8s.client"
import { AuthGuard } from "../auth/auth.guard"
import { ConsoleAdminGuard } from "../auth/admin.guard"

// Branding for the sign-in card. Lives in a Secret in the
// `platform-console` namespace (Secret rather than ConfigMap because
// the api SA already has Secret verbs cluster-wide; adding ConfigMap
// to the ClusterRole would mean another infra change). The values
// are not sensitive — they're going to be served over an
// unauthenticated GET — but storage type doesn't matter to the
// reader either way.
//
// Two endpoints:
//   GET /branding         — public (no auth). The sign-in page hits
//                           this server-side to render the aside.
//   PUT /branding         — admin-gated. Settings page edits values.

const BRANDING_SECRET = "console-branding"
const BRANDING_NS = "platform-console"

const COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const URL_RE = /^https?:\/\/[^\s]+$/

export type Branding = {
  color: string // hex like #0f0f11; empty string = default
  imageUrl: string // https://...; empty string = no image
  title: string // wordmark
  description: string // subtitle, hidden on mobile
}

const DEFAULTS: Branding = {
  color: "",
  imageUrl: "",
  title: "Console",
  description: "",
}

@Controller("branding")
export class BrandingController {
  @Get()
  async get(): Promise<Branding> {
    const secret = await readSecret()
    if (!secret) return DEFAULTS
    return decode(secret.data ?? {})
  }

  @Put()
  @UseGuards(AuthGuard, ConsoleAdminGuard)
  @HttpCode(204)
  async update(@Body() body: Partial<Branding>): Promise<void> {
    const next: Branding = {
      color: typeof body.color === "string" ? body.color.trim() : "",
      imageUrl:
        typeof body.imageUrl === "string" ? body.imageUrl.trim() : "",
      title:
        typeof body.title === "string" && body.title.trim()
          ? body.title.trim().slice(0, 60)
          : DEFAULTS.title,
      description:
        typeof body.description === "string"
          ? body.description.trim().slice(0, 200)
          : "",
    }
    if (next.color && !COLOR_RE.test(next.color)) {
      throw new BadRequestException("color must be a #RGB / #RRGGBB / #RRGGBBAA hex")
    }
    if (next.imageUrl && !URL_RE.test(next.imageUrl)) {
      throw new BadRequestException("imageUrl must start with http:// or https://")
    }
    await writeSecret(next)
  }
}

type SecretSnapshot = {
  metadata?: { resourceVersion?: string }
  data?: Record<string, string>
}

async function readSecret(): Promise<SecretSnapshot | null> {
  try {
    const res = await k8sCore().readNamespacedSecret({
      name: BRANDING_SECRET,
      namespace: BRANDING_NS,
    })
    return res as SecretSnapshot
  } catch (err) {
    const e = err as { code?: number; statusCode?: number }
    if ((e.code ?? e.statusCode) === 404) return null
    throw err
  }
}

function decode(data: Record<string, string>): Branding {
  const get = (k: string): string => {
    const raw = data[k]
    if (!raw) return ""
    try {
      return Buffer.from(raw, "base64").toString("utf8")
    } catch {
      return ""
    }
  }
  return {
    color: get("color"),
    imageUrl: get("imageUrl"),
    title: get("title") || DEFAULTS.title,
    description: get("description"),
  }
}

function encode(b: Branding): Record<string, string> {
  const enc = (v: string) => Buffer.from(v, "utf8").toString("base64")
  return {
    color: enc(b.color),
    imageUrl: enc(b.imageUrl),
    title: enc(b.title),
    description: enc(b.description),
  }
}

async function writeSecret(next: Branding): Promise<void> {
  const core = k8sCore()
  const existing = await readSecret()
  const data = encode(next)
  if (!existing) {
    await core.createNamespacedSecret({
      namespace: BRANDING_NS,
      body: {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: BRANDING_SECRET,
          namespace: BRANDING_NS,
          labels: { "agent-platform/component": "branding" },
        },
        type: "Opaque",
        data,
      },
    })
    return
  }
  await core.replaceNamespacedSecret({
    name: BRANDING_SECRET,
    namespace: BRANDING_NS,
    body: {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: BRANDING_SECRET,
        namespace: BRANDING_NS,
        resourceVersion: existing.metadata?.resourceVersion,
        labels: { "agent-platform/component": "branding" },
      },
      type: "Opaque",
      data,
    },
  })
}
