import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common"
import { type AppSession } from "@workspace/auth"
import { AuthGuard } from "../../auth/auth.guard"
import { ConsoleAdminGuard } from "../../auth/admin.guard"
import { CurrentSession } from "../../auth/session.decorator"
import { FunctionsService } from "./functions.service"
import { CreateFunctionInput, FunctionRuntime } from "./functions.types"

@Controller("functions")
@UseGuards(AuthGuard)
export class FunctionsController {
  constructor(private readonly fns: FunctionsService) {}

  @Get()
  list(@CurrentSession() session: AppSession) {
    return this.fns.listForOwner(session.user.id)
  }

  @Get("all")
  @UseGuards(ConsoleAdminGuard)
  listAll() {
    return this.fns.listAll()
  }

  @Get(":slug")
  get(
    @Param("slug") slug: string,
    @CurrentSession() session: AppSession,
  ) {
    return this.fns.get(session.user.id, slug)
  }

  @Post()
  create(
    @Body() body: Partial<CreateFunctionInput>,
    @CurrentSession() session: AppSession,
  ) {
    return this.fns.create(session.user.id, {
      name: (body.name ?? "").toString(),
      runtime: (body.runtime ?? "node20") as FunctionRuntime,
    })
  }

  @Patch(":slug")
  async rename(
    @Param("slug") slug: string,
    @Body() body: { name?: string },
    @CurrentSession() session: AppSession,
  ) {
    await this.fns.rename(session.user.id, slug, body.name ?? "")
    return { ok: true }
  }

  @Delete(":slug")
  @HttpCode(204)
  async delete(
    @Param("slug") slug: string,
    @CurrentSession() session: AppSession,
  ) {
    await this.fns.delete(session.user.id, slug)
  }
}
