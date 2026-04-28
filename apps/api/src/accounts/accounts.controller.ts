import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  UseGuards,
} from "@nestjs/common"
import { type AppSession } from "@workspace/auth"
import { AuthGuard } from "../auth/auth.guard"
import {
  ConsoleAdminGuard,
  PLATFORM_ADMIN_GROUP,
  PlatformAdminGuard,
} from "../auth/admin.guard"
import { CurrentSession } from "../auth/session.decorator"
import { OpenFgaService } from "../openfga/openfga.service"
import { AccountsService } from "./accounts.service"

@Controller("accounts")
@UseGuards(AuthGuard)
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly fga: OpenFgaService,
  ) {}

  @Get("me")
  async me(@CurrentSession() session: AppSession) {
    const { id, email, name, image, groups } = session.user
    const isPlatformAdmin = groups.includes(PLATFORM_ADMIN_GROUP)
    // Strict semantics: `isConsoleAdmin` is true only if the FGA tuple
    // exists. The UI ORs the two flags when deciding what to render.
    const isConsoleAdmin = await this.fga.isConsoleAdmin(id)
    return {
      id,
      email,
      name,
      image,
      groups,
      isPlatformAdmin,
      isConsoleAdmin,
    }
  }

  @Get()
  @UseGuards(ConsoleAdminGuard)
  list() {
    return this.accounts.listAll()
  }

  // Hard-delete a user: drops the better-auth row(s) and any stray FGA
  // tuples. Platform-admin only; cannot delete yourself. Note that this
  // does NOT touch Keycloak — a deleted user with the `platform-admin`
  // group will reappear (with a fresh id) on next OIDC sign-in.
  @Delete(":userId")
  @UseGuards(PlatformAdminGuard)
  @HttpCode(204)
  async delete(
    @Param("userId") userId: string,
    @CurrentSession() session: AppSession,
  ) {
    if (!userId || /[\s:]/.test(userId)) {
      throw new BadRequestException("Invalid userId")
    }
    if (userId === session.user.id) {
      throw new BadRequestException("Cannot delete your own account.")
    }

    await this.fga.cleanupUserTuples(userId)
    const deleted = await this.accounts.deleteById(userId)
    if (!deleted) {
      throw new NotFoundException()
    }
  }
}
