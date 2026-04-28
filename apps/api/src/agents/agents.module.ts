import { Module } from "@nestjs/common"
import { OpenFgaModule } from "../openfga/openfga.module"
import { AgentsAuthController, AgentsController } from "./agents.controller"
import { AgentsService } from "./agents.service"

@Module({
  imports: [OpenFgaModule],
  controllers: [AgentsController, AgentsAuthController],
  providers: [AgentsService],
})
export class AgentsModule {}
