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
import { CurrentSession } from "../auth/session.decorator"
import { VolumesService } from "./volumes.service"
import { CreateVolumeInput } from "./volumes.types"

@Controller("volumes")
@UseGuards(AuthGuard)
export class VolumesController {
  constructor(private readonly volumes: VolumesService) {}

  @Get()
  async list(@CurrentSession() session: AppSession) {
    return this.volumes.listForOwner(session.user.id)
  }

  @Post()
  async create(
    @Body() body: Partial<CreateVolumeInput>,
    @CurrentSession() session: AppSession,
  ) {
    const name = (body.name ?? "").toString().trim()
    const sizeGi = Number(body.sizeGi)
    if (!name) throw new BadRequestException("name is required")
    if (!Number.isFinite(sizeGi) || sizeGi < 1) {
      throw new BadRequestException("sizeGi must be a number >= 1")
    }
    return this.volumes.create(session.user.id, { name, sizeGi })
  }

  @Delete(":slug")
  @HttpCode(204)
  async delete(
    @Param("slug") slug: string,
    @CurrentSession() session: AppSession,
  ) {
    await this.volumes.delete(session.user.id, slug)
  }
}
