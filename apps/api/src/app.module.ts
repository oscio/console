import { Module } from "@nestjs/common"
import { AppController } from "./app.controller"
import { AccountsModule } from "./accounts/accounts.module"
import { AdminModule } from "./admin/admin.module"
import { AgentChatModule } from "./agent-chat/agent-chat.module"
import { AgentsModule } from "./agents/agents.module"
import { OpenFgaModule } from "./openfga/openfga.module"
import { RoleBindingsModule } from "./role-bindings/role-bindings.module"
import { LoadBalancersModule } from "./loadbalancers/loadbalancers.module"
import { ReposModule } from "./repos/repos.module"
import { FunctionsModule } from "./services/functions/functions.module"
import { VmsModule } from "./vms/vms.module"
import { VolumesModule } from "./volumes/volumes.module"

@Module({
  imports: [
    OpenFgaModule,
    AccountsModule,
    RoleBindingsModule,
    VolumesModule,
    VmsModule,
    AgentsModule,
    AgentChatModule,
    LoadBalancersModule,
    ReposModule,
    FunctionsModule,
    AdminModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
