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
import { AuthGuard } from "../auth/auth.guard"
import { ConsoleAdminGuard, PLATFORM_ADMIN_GROUP } from "../auth/admin.guard"
import { CurrentSession } from "../auth/session.decorator"
import { OpenFgaService } from "../openfga/openfga.service"
import { AgentsService } from "./agents.service"
import { AgentType, CreateAgentInput } from "./agents.types"

const ALLOWED_AGENT: ReadonlySet<AgentType> = new Set(["hermes", "openclaw"])

// Traefik ForwardAuth target. Same pattern as VmsAuthController:
// reaches us through Traefik (no better-auth cookie), so the source
// of truth is the X-Auth-Request-* headers oauth2-proxy sets.
@Controller("agents/auth")
export class AgentsAuthController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  @HttpCode(200)
  async forwardAuth(
    @Headers("x-auth-request-email") authEmail: string | undefined,
    @Headers("x-auth-request-groups") authGroups: string | undefined,
    @Headers("x-forwarded-host") forwardedHost: string | undefined,
  ) {
    if (!authEmail) throw new ForbiddenException("not authenticated")
    if (!forwardedHost) throw new ForbiddenException("no host")

    const slug = extractAgentSlug(forwardedHost)
    if (!slug) throw new ForbiddenException("not an agent host")

    if (
      (authGroups ?? "")
        .split(",")
        .map((g) => g.trim())
        .includes(PLATFORM_ADMIN_GROUP)
    ) {
      return { allowed: true, reason: "platform-admin", slug }
    }

    const allowed = await this.agents.canAccessByEmail(authEmail, slug)
    if (!allowed) throw new ForbiddenException(`not the owner of ${slug}`)
    return { allowed: true, slug }
  }
}

@Controller("agents")
@UseGuards(AuthGuard)
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly fga: OpenFgaService,
  ) {}

  @Get()
  async list(@CurrentSession() session: AppSession) {
    return this.agents.listForOwner(session.user.id)
  }

  @Get("all")
  @UseGuards(ConsoleAdminGuard)
  listAll() {
    return this.agents.listAll()
  }

  @Post()
  async create(
    @Body() body: Partial<CreateAgentInput>,
    @CurrentSession() session: AppSession,
  ) {
    const name = (body.name ?? "").toString().trim()
    const agentType = body.agentType as AgentType
    if (!name) throw new BadRequestException("name is required")
    if (!ALLOWED_AGENT.has(agentType)) {
      throw new BadRequestException(
        `agentType must be one of: ${[...ALLOWED_AGENT].join(", ")}`,
      )
    }
    return this.agents.create(session.user.id, {
      name,
      agentType,
      storageSize: body.storageSize,
    })
  }

  @Delete(":slug")
  @HttpCode(204)
  async delete(
    @Param("slug") slug: string,
    @CurrentSession() session: AppSession,
  ) {
    await this.agents.delete(session.user.id, slug)
  }
}

// Agent hostnames are `<slug>.agents.<domain>` where slug starts
// `agent-` followed by 8 hex chars. Anything else falls through.
function extractAgentSlug(host: string): string | null {
  const match = /^(agent-[a-f0-9]{8})\./.exec(host)
  return match?.[1] ?? null
}
