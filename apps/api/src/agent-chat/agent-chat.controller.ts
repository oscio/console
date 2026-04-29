import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common"
import type { Response } from "express"
import { type AppSession } from "@workspace/auth"
import { AuthGuard } from "../auth/auth.guard"
import { CurrentSession } from "../auth/session.decorator"
import { AgentChatService, type Resource } from "./agent-chat.service"

// Two parallel controllers (VM-attached agent vs standalone agent)
// share the same handler shape — only the resource type differs.
// Anything past `/sessions` and `/tasks*` is passed through to the
// wrapper as-is, so adding a new wrapper endpoint here is one route
// per side.

class BaseAgentChatController {
  protected readonly resource: Resource = "vm"
  constructor(protected readonly chat: AgentChatService) {}

  protected async authd<T>(
    session: AppSession,
    slug: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    await this.chat.assertOwner(session.user.id, this.resource, slug)
    return fn()
  }
}

@Controller("vms/:slug/agent")
@UseGuards(AuthGuard)
export class VmAgentChatController extends BaseAgentChatController {
  protected readonly resource: Resource = "vm"
  constructor(chat: AgentChatService) {
    super(chat)
  }

  @Post("sessions")
  createSession(
    @Param("slug") slug: string,
    @Body() body: unknown,
    @CurrentSession() session: AppSession,
  ) {
    return this.authd(session, slug, () =>
      this.chat.proxyJson(slug, "POST", "/sessions", body) as Promise<unknown>,
    )
  }

  @Get("sessions")
  listSessions(
    @Param("slug") slug: string,
    @CurrentSession() session: AppSession,
  ) {
    return this.authd(session, slug, () =>
      this.chat.proxyJson(slug, "GET", "/sessions") as Promise<unknown>,
    )
  }

  @Post("tasks")
  createTask(
    @Param("slug") slug: string,
    @Body() body: unknown,
    @CurrentSession() session: AppSession,
  ) {
    return this.authd(session, slug, () =>
      this.chat.proxyJson(slug, "POST", "/tasks", body) as Promise<unknown>,
    )
  }

  @Get("tasks")
  listTasks(
    @Param("slug") slug: string,
    @CurrentSession() session: AppSession,
  ) {
    return this.authd(session, slug, () =>
      this.chat.proxyJson(slug, "GET", "/tasks") as Promise<unknown>,
    )
  }

  @Get("tasks/:taskId")
  getTask(
    @Param("slug") slug: string,
    @Param("taskId") taskId: string,
    @CurrentSession() session: AppSession,
  ) {
    return this.authd(session, slug, () =>
      this.chat.proxyJson(
        slug,
        "GET",
        `/tasks/${encodeURIComponent(taskId)}`,
      ) as Promise<unknown>,
    )
  }

  @Get("tasks/:taskId/stream")
  async streamTask(
    @Param("slug") slug: string,
    @Param("taskId") taskId: string,
    @CurrentSession() session: AppSession,
    @Res() res: Response,
  ) {
    await this.authd(session, slug, async () => {
      await this.chat.proxyStream(
        slug,
        `/tasks/${encodeURIComponent(taskId)}/stream`,
        res,
      )
    })
  }

  @Post("tasks/:taskId/cancel")
  cancelTask(
    @Param("slug") slug: string,
    @Param("taskId") taskId: string,
    @CurrentSession() session: AppSession,
  ) {
    return this.authd(session, slug, () =>
      this.chat.proxyJson(
        slug,
        "POST",
        `/tasks/${encodeURIComponent(taskId)}/cancel`,
      ) as Promise<unknown>,
    )
  }
}

@Controller("agents/:slug/chat")
@UseGuards(AuthGuard)
export class AgentChatController extends BaseAgentChatController {
  protected readonly resource: Resource = "agent"
  constructor(chat: AgentChatService) {
    super(chat)
  }

  @Post("sessions")
  createSession(
    @Param("slug") slug: string,
    @Body() body: unknown,
    @CurrentSession() session: AppSession,
  ) {
    return this.authd(session, slug, () =>
      this.chat.proxyJson(slug, "POST", "/sessions", body) as Promise<unknown>,
    )
  }

  @Get("sessions")
  listSessions(
    @Param("slug") slug: string,
    @CurrentSession() session: AppSession,
  ) {
    return this.authd(session, slug, () =>
      this.chat.proxyJson(slug, "GET", "/sessions") as Promise<unknown>,
    )
  }

  @Post("tasks")
  createTask(
    @Param("slug") slug: string,
    @Body() body: unknown,
    @CurrentSession() session: AppSession,
  ) {
    return this.authd(session, slug, () =>
      this.chat.proxyJson(slug, "POST", "/tasks", body) as Promise<unknown>,
    )
  }

  @Get("tasks")
  listTasks(
    @Param("slug") slug: string,
    @CurrentSession() session: AppSession,
  ) {
    return this.authd(session, slug, () =>
      this.chat.proxyJson(slug, "GET", "/tasks") as Promise<unknown>,
    )
  }

  @Get("tasks/:taskId")
  getTask(
    @Param("slug") slug: string,
    @Param("taskId") taskId: string,
    @CurrentSession() session: AppSession,
  ) {
    return this.authd(session, slug, () =>
      this.chat.proxyJson(
        slug,
        "GET",
        `/tasks/${encodeURIComponent(taskId)}`,
      ) as Promise<unknown>,
    )
  }

  @Get("tasks/:taskId/stream")
  async streamTask(
    @Param("slug") slug: string,
    @Param("taskId") taskId: string,
    @CurrentSession() session: AppSession,
    @Res() res: Response,
  ) {
    await this.authd(session, slug, async () => {
      await this.chat.proxyStream(
        slug,
        `/tasks/${encodeURIComponent(taskId)}/stream`,
        res,
      )
    })
  }

  @Post("tasks/:taskId/cancel")
  cancelTask(
    @Param("slug") slug: string,
    @Param("taskId") taskId: string,
    @CurrentSession() session: AppSession,
  ) {
    return this.authd(session, slug, () =>
      this.chat.proxyJson(
        slug,
        "POST",
        `/tasks/${encodeURIComponent(taskId)}/cancel`,
      ) as Promise<unknown>,
    )
  }
}
