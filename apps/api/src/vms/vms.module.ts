import { Module } from "@nestjs/common"
import { OpenFgaModule } from "../openfga/openfga.module"
import { VmsAuthController, VmsController } from "./vms.controller"
import { VmsService } from "./vms.service"

@Module({
  imports: [OpenFgaModule],
  controllers: [VmsController, VmsAuthController],
  providers: [VmsService],
})
export class VmsModule {}
