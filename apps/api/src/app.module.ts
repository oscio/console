import { Module } from "@nestjs/common"
import { AppController } from "./app.controller"
import { AccountsModule } from "./accounts/accounts.module"
import { OpenFgaModule } from "./openfga/openfga.module"
import { RoleBindingsModule } from "./role-bindings/role-bindings.module"

@Module({
  imports: [OpenFgaModule, AccountsModule, RoleBindingsModule],
  controllers: [AppController],
})
export class AppModule {}
