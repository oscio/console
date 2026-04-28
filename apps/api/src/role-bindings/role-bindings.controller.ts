import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  UseGuards,
} from "@nestjs/common"
import { AuthGuard } from "../auth/auth.guard"
import { PlatformAdminGuard } from "../auth/admin.guard"
import { OpenFgaService } from "../openfga/openfga.service"

// Role-binding management is platform-admin-only. Console-admins can read
// the user list but never manage roles.
//
// Only `console-admin` is bindable here — `platform-admin` is sourced from
// Keycloak and intentionally has no API surface to grant/revoke in-app.
@Controller("role-bindings")
@UseGuards(AuthGuard, PlatformAdminGuard)
export class RoleBindingsController {
  constructor(private readonly fga: OpenFgaService) {}

  @Get()
  async list() {
    return { console_admins: await this.fga.listConsoleAdmins() }
  }

  @Put("console-admin/:userId")
  @HttpCode(204)
  async grant(@Param("userId") userId: string) {
    assertUserId(userId)
    await this.fga.grantConsoleAdmin(userId)
  }

  @Delete("console-admin/:userId")
  @HttpCode(204)
  async revoke(@Param("userId") userId: string) {
    assertUserId(userId)
    // No "last admin" guard — platform-admin status is independent of
    // console-admin tuples, so revoking the last console-admin can't
    // lock platform-admins out.
    await this.fga.revokeConsoleAdmin(userId)
  }
}

function assertUserId(userId: string): void {
  // better-auth uses string ids — keep this loose but reject obvious junk
  // that could end up in an FGA tuple subject.
  if (!userId || /[\s:]/.test(userId)) {
    throw new BadRequestException("Invalid userId")
  }
}
