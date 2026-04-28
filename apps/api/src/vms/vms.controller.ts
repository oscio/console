import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common"
import { type AppSession } from "@workspace/auth"
import { AuthGuard } from "../auth/auth.guard"
import { ConsoleAdminGuard } from "../auth/admin.guard"
import { CurrentSession } from "../auth/session.decorator"
import { VmsService } from "./vms.service"
import { CreateVmInput, VmAgentType, VmImageType } from "./vms.types"

const ALLOWED_IMAGE: ReadonlySet<VmImageType> = new Set(["base", "desktop"])
const ALLOWED_AGENT: ReadonlySet<VmAgentType> = new Set(["hermes", "none"])

@Controller("vms")
@UseGuards(AuthGuard)
export class VmsController {
  constructor(private readonly vms: VmsService) {}

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
    const agentType = (body.agentType ?? "hermes") as VmAgentType
    if (!name) throw new BadRequestException("name is required")
    if (!ALLOWED_IMAGE.has(imageType)) {
      throw new BadRequestException("imageType must be 'base' or 'desktop'")
    }
    if (!ALLOWED_AGENT.has(agentType)) {
      throw new BadRequestException("agentType must be 'hermes' or 'none'")
    }
    return this.vms.create(session.user.id, {
      name,
      imageType,
      agentType,
      storageSize: body.storageSize,
    })
  }

  @Delete(":name")
  @HttpCode(204)
  async delete(
    @Param("name") name: string,
    @CurrentSession() session: AppSession,
  ) {
    await this.vms.delete(session.user.id, name)
  }
}
