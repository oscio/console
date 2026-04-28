import { Module } from "@nestjs/common"
import { AppController } from "./app.controller"
import { AccountsModule } from "./accounts/accounts.module"
import { AgentsModule } from "./agents/agents.module"
import { OpenFgaModule } from "./openfga/openfga.module"
import { RoleBindingsModule } from "./role-bindings/role-bindings.module"
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
  ],
  controllers: [AppController],
})
export class AppModule {}
