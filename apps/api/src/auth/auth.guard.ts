import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common"
import { auth, type AppSession } from "@workspace/auth"
import { Request } from "express"

export type AuthedRequest = Request & { session: AppSession }

@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>()

    // better-auth reads the session cookie + verifies the signature against
    // BETTER_AUTH_SECRET, so we just forward the inbound headers.
    const session = await auth.api.getSession({
      headers: toFetchHeaders(req.headers),
    })

    if (!session) {
      throw new UnauthorizedException()
    }

    req.session = session as AppSession
    return true
  }
}

function toFetchHeaders(nodeHeaders: Request["headers"]): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v)
    } else {
      headers.set(key, value)
    }
  }
  return headers
}
