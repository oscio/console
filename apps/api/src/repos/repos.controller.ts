import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common"
import { type AppSession } from "@workspace/auth"
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard"
import { ConsoleAdminGuard, isPlatformAdmin } from "../auth/admin.guard"
import { CurrentSession } from "../auth/session.decorator"
import { OpenFgaService } from "../openfga/openfga.service"
import { ReposService } from "./repos.service"
import {
  CreateRepoInput,
  ForkRepoInput,
  ImportRepoInput,
} from "./repos.types"

@Controller("repos")
@UseGuards(AuthGuard)
export class ReposController {
  constructor(
    private readonly repos: ReposService,
    private readonly fga: OpenFgaService,
  ) {}

  // platform-admin / console-admin see everything (mine + platform +
  // every other user's), regular users only see their own. Sources for
  // the Fork picker are still listed via /repos/sources regardless of
  // role.
  @Get()
  async list(
    @Req() req: AuthedRequest,
    @CurrentSession() session: AppSession,
  ) {
    if (
      isPlatformAdmin(req) ||
      (await this.fga.isConsoleAdmin(session.user.id))
    ) {
      return this.repos.listAll()
    }
    return this.repos.listForOwner(session.user.id)
  }

  @Get("all")
  @UseGuards(ConsoleAdminGuard)
  listAll() {
    return this.repos.listAll()
  }

  // Anyone signed in can see the platform-shared catalog so the Fork
  // dialog has something to pick from.
  @Get("sources")
  listSources() {
    return this.repos.listForkSources()
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

  @Post("fork")
  fork(
    @Body() body: Partial<ForkRepoInput>,
    @CurrentSession() session: AppSession,
  ) {
    return this.repos.fork(session.user.id, {
      sourceOrg: (body.sourceOrg ?? "").toString(),
      sourceName: (body.sourceName ?? "").toString(),
      name: body.name?.toString(),
    })
  }

  @Post("import")
  import(
    @Body() body: Partial<ImportRepoInput>,
    @CurrentSession() session: AppSession,
  ) {
    return this.repos.import(session.user.id, {
      githubUrl: (body.githubUrl ?? "").toString(),
      name: body.name?.toString(),
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
