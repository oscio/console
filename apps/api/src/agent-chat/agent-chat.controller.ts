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
import { AgentChatService } from "./agent-chat.service"

// Single chat endpoint family. Slug works for both standalone agents
// (agent-XXXXXXXX) and VM-attached sidecars (vm-XXXXXXXX) — the
// wrapper inside the pod listens on port 8000 in either case, and
// the FGA tuple `agent:<slug>` is written for both at create time.
// VM-attached agents surface in /agents listing alongside standalone
// ones, so the URL shape stays uniform: /agents/<slug>/chat/...

@Controller("agents/:slug/chat")
@UseGuards(AuthGuard)
export class AgentChatController {
  constructor(private readonly chat: AgentChatService) {}

  private async authd<T>(
    session: AppSession,
    slug: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    await this.chat.assertOwner(session.user.id, slug)
    return fn()
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
