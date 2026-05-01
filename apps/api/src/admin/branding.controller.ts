import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Put,
  UseGuards,
} from "@nestjs/common"
import { authPool } from "@workspace/auth"
import { AuthGuard } from "../auth/auth.guard"
import { ConsoleAdminGuard } from "../auth/admin.guard"

// Branding for the sign-in card and the sidebar header. Stored in
// Postgres (single-row "branding" table seeded by main.ts) rather
// than k8s, so admin edits don't need cluster perms or a Secret
// replace cycle. The values are non-sensitive — GET is public so
// the unauthenticated /sign-in page can render.
//
// Two endpoints:
//   GET /branding  — public (no auth). Sign-in + authed layout.
//   PUT /branding  — admin-gated. Settings page edits values.

const COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const URL_RE = /^https?:\/\/[^\s]+$/

export type Branding = {
  color: string // bg, hex; empty string = default dark
  textColor: string // foreground, hex; empty string = default white
  imageUrl: string // https://...; empty string = no image
  title: string // wordmark
  description: string // subtitle, hidden on mobile
}

const DEFAULTS: Branding = {
  color: "",
  textColor: "",
  imageUrl: "",
  title: "Console",
  description: "",
}

@Controller("branding")
export class BrandingController {
  @Get()
  async get(): Promise<Branding> {
    const { rows } = await authPool.query<{
      color: string
      text_color: string
      image_url: string
      title: string
      description: string
    }>(
      `SELECT color, text_color, image_url, title, description FROM "branding" WHERE id = 1`,
    )
    const r = rows[0]
    if (!r) return DEFAULTS
    return {
      color: r.color,
      textColor: r.text_color,
      imageUrl: r.image_url,
      title: r.title || DEFAULTS.title,
      description: r.description,
    }
  }

  @Put()
  @UseGuards(AuthGuard, ConsoleAdminGuard)
  @HttpCode(204)
  async update(@Body() body: Partial<Branding>): Promise<void> {
    const next: Branding = {
      color: typeof body.color === "string" ? body.color.trim() : "",
      textColor:
        typeof body.textColor === "string" ? body.textColor.trim() : "",
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
      throw new BadRequestException(
        "color must be a #RGB / #RRGGBB / #RRGGBBAA hex",
      )
    }
    if (next.textColor && !COLOR_RE.test(next.textColor)) {
      throw new BadRequestException(
        "textColor must be a #RGB / #RRGGBB / #RRGGBBAA hex",
      )
    }
    if (next.imageUrl && !URL_RE.test(next.imageUrl)) {
      throw new BadRequestException(
        "imageUrl must start with http:// or https://",
      )
    }
    await authPool.query(
      `UPDATE "branding"
         SET color = $1,
             text_color = $2,
             image_url = $3,
             title = $4,
             description = $5,
             updated_at = now()
       WHERE id = 1`,
      [
        next.color,
        next.textColor,
        next.imageUrl,
        next.title,
        next.description,
      ],
    )
  }
}
