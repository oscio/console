import { Module } from "@nestjs/common"
import { OpenFgaModule } from "../../openfga/openfga.module"
import { FunctionsController } from "./functions.controller"
import { FunctionsService } from "./functions.service"

@Module({
  imports: [OpenFgaModule],
  controllers: [FunctionsController],
  providers: [FunctionsService],
})
export class FunctionsModule {}
