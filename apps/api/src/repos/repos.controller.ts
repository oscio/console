import {
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
import { ReposService } from "./repos.service"
import { CreateRepoInput } from "./repos.types"

@Controller("repos")
@UseGuards(AuthGuard)
export class ReposController {
  constructor(private readonly repos: ReposService) {}

  @Get()
  list(@CurrentSession() session: AppSession) {
    return this.repos.listForOwner(session.user.id)
  }

  @Get("all")
  @UseGuards(ConsoleAdminGuard)
  listAll() {
    return this.repos.listAll()
  }

  @Post()
  create(
    @Body() body: Partial<CreateRepoInput>,
    @CurrentSession() session: AppSession,
  ) {
    return this.repos.create(session.user.id, {
      name: (body.name ?? "").toString(),
    })
  }

  @Get(":slug")
  get(@Param("slug") slug: string, @CurrentSession() session: AppSession) {
    return this.repos.get(session.user.id, slug)
  }

  @Delete(":slug")
  @HttpCode(204)
  remove(
    @Param("slug") slug: string,
    @CurrentSession() session: AppSession,
  ) {
    return this.repos.delete(session.user.id, slug)
  }
}
