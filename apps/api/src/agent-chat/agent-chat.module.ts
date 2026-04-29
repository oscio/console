import { Module } from "@nestjs/common"
import { OpenFgaModule } from "../openfga/openfga.module"
import { AgentChatController, VmAgentChatController } from "./agent-chat.controller"
import { AgentChatService } from "./agent-chat.service"

@Module({
  imports: [OpenFgaModule],
  controllers: [VmAgentChatController, AgentChatController],
  providers: [AgentChatService],
})
export class AgentChatModule {}
