import { createParamDecorator, ExecutionContext } from "@nestjs/common"
import type { AuthedRequest } from "./auth.guard"

export const CurrentSession = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>()
    return req.session
  },
)
