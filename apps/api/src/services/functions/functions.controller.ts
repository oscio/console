import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
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

  @Put(":slug/expose")
  setExposed(
    @Param("slug") slug: string,
    @Body() body: { exposed?: boolean },
    @CurrentSession() session: AppSession,
  ) {
    return this.fns.setExposed(session.user.id, slug, !!body.exposed)
  }

  @Get(":slug/files")
  getFiles(
    @Param("slug") slug: string,
    @CurrentSession() session: AppSession,
  ) {
    return this.fns.getFiles(session.user.id, slug)
  }

  @Get(":slug/runtime")
  getRuntime(
    @Param("slug") slug: string,
    @CurrentSession() session: AppSession,
  ) {
    return this.fns.getRuntime(session.user.id, slug)
  }

  @Post(":slug/deploy")
  deploy(
    @Param("slug") slug: string,
    @CurrentSession() session: AppSession,
  ) {
    return this.fns.deployToProduction(session.user.id, slug)
  }

  @Post(":slug/invoke")
  invoke(
    @Param("slug") slug: string,
    @Body()
    body: {
      method?: string
      path?: string
      headers?: Record<string, string>
      body?: string
      target?: "dev" | "prod"
    },
    @CurrentSession() session: AppSession,
  ) {
    return this.fns.invoke(session.user.id, slug, {
      method: String(body.method ?? "GET"),
      path: String(body.path ?? "/"),
      headers: body.headers ?? {},
      body: typeof body.body === "string" ? body.body : "",
      target: body.target === "prod" ? "prod" : "dev",
    })
  }

  @Put(":slug/files")
  updateFiles(
    @Param("slug") slug: string,
    @Body()
    body: {
      files?: { path?: string; content?: string }[]
      deletes?: string[]
      message?: string
    },
    @CurrentSession() session: AppSession,
  ) {
    const files = (body.files ?? [])
      .filter(
        (f): f is { path: string; content: string } =>
          typeof f.path === "string" && typeof f.content === "string",
      )
      .map((f) => ({ path: f.path, content: f.content }))
    const deletes = (body.deletes ?? []).filter(
      (p): p is string => typeof p === "string",
    )
    return this.fns.updateFiles(session.user.id, slug, {
      files,
      deletes,
      message: body.message,
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
