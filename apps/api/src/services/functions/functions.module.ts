import { Module } from "@nestjs/common"
import { ForgejoModule } from "../../forgejo/forgejo.module"
import { HarborModule } from "../../harbor/harbor.module"
import { OpenFgaModule } from "../../openfga/openfga.module"
import { FunctionsController } from "./functions.controller"
import { FunctionsService } from "./functions.service"

@Module({
  imports: [ForgejoModule, HarborModule, OpenFgaModule],
  controllers: [FunctionsController],
  providers: [FunctionsService],
})
export class FunctionsModule {}
