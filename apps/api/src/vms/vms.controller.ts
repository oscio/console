import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common"
import { type AppSession } from "@workspace/auth"
import { AGENT_MODEL_RE } from "../agents/agents.types"
import { AuthGuard } from "../auth/auth.guard"
import { ConsoleAdminGuard, PLATFORM_ADMIN_GROUP } from "../auth/admin.guard"
import { CurrentSession } from "../auth/session.decorator"
import { OpenFgaService } from "../openfga/openfga.service"
import { VmsService } from "./vms.service"
import { CreateVmInput, VmAgentType, VmImageType } from "./vms.types"

const ALLOWED_IMAGE: ReadonlySet<VmImageType> = new Set(["base", "desktop"])
const ALLOWED_AGENT: ReadonlySet<VmAgentType> = new Set([
  "none",
  "hermes",
  "zeroclaw",
])

// Traefik ForwardAuth target. Called for every request to a VM
// hostname (vm-XXX-{term,code,vnc}.vm.<domain>) AFTER oauth2-proxy
// has authenticated the session. NO AuthGuard — the request reaches
// us via Traefik, not the browser, and carries no better-auth cookie.
// oauth2-proxy is the source of truth via X-Auth-Request-* headers.
@Controller("vms/auth")
export class VmsAuthController {
  constructor(private readonly vms: VmsService) {}

  // 200 → Traefik forwards to the VM upstream.
  // 403 → Traefik returns 403 (not the owner / unauthenticated).
  @Get()
  @HttpCode(200)
  async forwardAuth(
    @Headers("x-auth-request-email") authEmail: string | undefined,
    @Headers("x-auth-request-groups") authGroups: string | undefined,
    @Headers("x-forwarded-host") forwardedHost: string | undefined,
  ) {
    if (!authEmail) throw new ForbiddenException("not authenticated")
    if (!forwardedHost) throw new ForbiddenException("no host")

    const slug = extractVmSlug(forwardedHost)
    if (!slug) throw new ForbiddenException("not a VM host")

    // platform-admins (Keycloak group) get a free pass — same as
    // every other admin path in the codebase.
    if (
      (authGroups ?? "")
        .split(",")
        .map((g) => g.trim())
        .includes(PLATFORM_ADMIN_GROUP)
    ) {
      return { allowed: true, reason: "platform-admin", slug }
    }

    const allowed = await this.vms.canAccessByEmail(authEmail, slug)
    if (!allowed) throw new ForbiddenException(`not the owner of ${slug}`)
    return { allowed: true, slug }
  }
}

@Controller("vms")
@UseGuards(AuthGuard)
export class VmsController {
  constructor(
    private readonly vms: VmsService,
    private readonly fga: OpenFgaService,
  ) {}

  // Console-admin sees all VMs cluster-wide; everyone else gets their
  // own. Same controller, different scope.
  @Get()
  async list(@CurrentSession() session: AppSession) {
    return this.vms.listForOwner(session.user.id)
  }

  @Get("all")
  @UseGuards(ConsoleAdminGuard)
  listAll() {
    return this.vms.listAll()
  }

  @Post()
  async create(
    @Body() body: Partial<CreateVmInput>,
    @CurrentSession() session: AppSession,
  ) {
    const name = (body.name ?? "").toString().trim()
    const imageType = body.imageType as VmImageType
    const agentType = (body.agentType ?? "none") as VmAgentType
    if (!name) throw new BadRequestException("name is required")
    if (!ALLOWED_IMAGE.has(imageType)) {
      throw new BadRequestException("imageType must be 'base' or 'desktop'")
    }
    if (!ALLOWED_AGENT.has(agentType)) {
      throw new BadRequestException(
        `agentType must be one of: ${[...ALLOWED_AGENT].join(", ")}`,
      )
    }
    const volumeMode = (body.volumeMode ?? "new") as "new" | "attach" | "none"
    if (!new Set(["new", "attach", "none"]).has(volumeMode)) {
      throw new BadRequestException("volumeMode must be 'new', 'attach', or 'none'")
    }
    const loadBalancers = Array.isArray(body.loadBalancers)
      ? body.loadBalancers.map((lb) => {
          const item = lb as Record<string, unknown>
          return {
            name: typeof item.name === "string" ? item.name : undefined,
            port: Number(item.port),
          }
        })
      : undefined
    let agentModel: string | undefined
    if (
      agentType !== "none" &&
      typeof body.agentModel === "string" &&
      body.agentModel.length > 0
    ) {
      if (!AGENT_MODEL_RE.test(body.agentModel)) {
        throw new BadRequestException(
          "agentModel must look like 'provider/model-id' (OpenRouter shape)",
        )
      }
      agentModel = body.agentModel
    }
    return this.vms.create(session.user.id, {
      name,
      imageType,
      agentType,
      cpuRequest: body.cpuRequest,
      memoryRequest: body.memoryRequest,
      volumeMode,
      volumeName: body.volumeName,
      volumeSizeGi:
        body.volumeSizeGi != null ? Number(body.volumeSizeGi) : undefined,
      persistVolumeOnDelete: !!body.persistVolumeOnDelete,
      volumeSlug: body.volumeSlug,
      loadBalancers,
      agentModel,
      clusterAdmin: !!body.clusterAdmin,
    })
  }

  // Path param is the random slug (the K8s resource name), NOT the
  // human-readable display name — display names aren't unique.
  @Delete(":slug")
  @HttpCode(204)
  async delete(
    @Param("slug") slug: string,
    @CurrentSession() session: AppSession,
  ) {
    await this.vms.delete(session.user.id, slug)
  }
}

// VM hostnames are `<slug>-{term,code,vnc}.vm.<domain>`. Extract the
// slug, returning null when the host doesn't match the VM pattern (so
// the gate denies non-VM hosts that accidentally land on this route).
function extractVmSlug(host: string): string | null {
  const match = /^(vm-[a-f0-9]{8})-(?:term|code|vnc)\./.exec(host)
  return match?.[1] ?? null
}
