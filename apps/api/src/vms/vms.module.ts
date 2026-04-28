import { Module } from "@nestjs/common"
import { OpenFgaModule } from "../openfga/openfga.module"
import { VolumesModule } from "../volumes/volumes.module"
import { VmsAuthController, VmsController } from "./vms.controller"
import { VmsService } from "./vms.service"

@Module({
  imports: [OpenFgaModule, VolumesModule],
  controllers: [VmsController, VmsAuthController],
  providers: [VmsService],
})
export class VmsModule {}
