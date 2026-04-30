import { Module } from "@nestjs/common"
import { BrandingController } from "./branding.controller"
import { GlobalEnvController } from "./global-env.controller"

// Cluster-wide configuration surface for console-admins. Currently
// houses only the shared agent env (OPENROUTER_API_KEY etc.) and the
// sign-in branding values, but any other admin-managed cluster
// state (model defaults, allowlists, quota knobs) belongs here too.
@Module({
  controllers: [BrandingController, GlobalEnvController],
})
export class AdminModule {}
