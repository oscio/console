import { Controller, Get, Param, UseGuards } from "@nestjs/common"
import { type AppSession } from "@workspace/auth"
import { AuthGuard } from "../auth/auth.guard"
import { ConsoleAdminGuard } from "../auth/admin.guard"
import { CurrentSession } from "../auth/session.decorator"
import { ReposService } from "./repos.service"

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

  @Get(":slug")
  get(@Param("slug") slug: string, @CurrentSession() session: AppSession) {
    return this.repos.get(session.user.id, slug)
  }
}
