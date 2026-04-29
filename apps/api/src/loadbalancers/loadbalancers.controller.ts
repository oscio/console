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
import { LoadBalancersService } from "./loadbalancers.service"
import { CreateLoadBalancerInput } from "./loadbalancers.types"

@Controller("loadbalancers")
@UseGuards(AuthGuard)
export class LoadBalancersController {
  constructor(private readonly lbs: LoadBalancersService) {}

  @Get()
  async list(@CurrentSession() session: AppSession) {
    return this.lbs.listForOwner(session.user.id)
  }

  @Post()
  async create(
    @Body() body: Partial<CreateLoadBalancerInput>,
    @CurrentSession() session: AppSession,
  ) {
    const name = (body.name ?? "").toString().trim()
    const vmSlug = (body.vmSlug ?? "").toString().trim()
    const port = Number(body.port)
    if (!name) throw new BadRequestException("name is required")
    if (!vmSlug) throw new BadRequestException("vmSlug is required")
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new BadRequestException("port must be an integer 1-65535")
    }
    return this.lbs.create(session.user.id, {
      name,
      vmSlug,
      port,
      persistOnVmDelete: !!body.persistOnVmDelete,
    })
  }

  @Delete(":slug")
  @HttpCode(204)
  async delete(
    @Param("slug") slug: string,
    @CurrentSession() session: AppSession,
  ) {
    await this.lbs.delete(session.user.id, slug)
  }
}
