import { Module } from "@nestjs/common"
import { ForgejoModule } from "../forgejo/forgejo.module"
import { OpenFgaModule } from "../openfga/openfga.module"
import { ReposController } from "./repos.controller"
import { ReposService } from "./repos.service"

@Module({
  imports: [ForgejoModule, OpenFgaModule],
  controllers: [ReposController],
  providers: [ReposService],
})
export class ReposModule {}
