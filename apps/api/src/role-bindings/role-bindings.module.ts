import { Module } from "@nestjs/common"
import { RoleBindingsController } from "./role-bindings.controller"

@Module({
  controllers: [RoleBindingsController],
})
export class RoleBindingsModule {}
