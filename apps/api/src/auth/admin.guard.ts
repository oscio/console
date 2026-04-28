import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common"
import { OpenFgaService } from "../openfga/openfga.service"
import type { AuthedRequest } from "./auth.guard"

// Keycloak group name. Mirrored into better-auth's `user.groups` column on
// every login. Never stored as an FGA tuple — Keycloak owns this role
// outright, which is why it cannot be granted in-app.
export const PLATFORM_ADMIN_GROUP = "platform-admin"

// Strict platform-admin gate. Used for endpoints that mutate role
// bindings — only platform-admins (Keycloak) can promote console-admins.
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>()
    if (!isPlatformAdmin(req)) {
      throw new ForbiddenException()
    }
    return true
  }
}

// "At least console-admin" gate: passes if the caller is a platform-admin
// (Keycloak group) OR has the `console_admin` FGA tuple. Used for
// admin-but-not-role-mgmt views like the user list.
@Injectable()
export class ConsoleAdminGuard implements CanActivate {
  constructor(private readonly fga: OpenFgaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>()
    const user = req.session?.user
    if (!user) throw new ForbiddenException()

    if (isPlatformAdmin(req)) return true
    if (await this.fga.isConsoleAdmin(user.id)) return true

    throw new ForbiddenException()
  }
}

export function isPlatformAdmin(req: AuthedRequest): boolean {
  return (req.session?.user.groups ?? []).includes(PLATFORM_ADMIN_GROUP)
}
