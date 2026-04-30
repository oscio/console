import { Module } from "@nestjs/common"
import { GlobalEnvController } from "./global-env.controller"

// Cluster-wide configuration surface for console-admins. Currently
// houses only the shared agent env (OPENROUTER_API_KEY etc.) but
// any other admin-managed cluster state (model defaults, allowlists,
// quota knobs) belongs here too.
@Module({
  controllers: [GlobalEnvController],
})
export class AdminModule {}
