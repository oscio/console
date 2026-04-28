import { Module } from "@nestjs/common"
import { OpenFgaModule } from "../openfga/openfga.module"
import { VolumesController } from "./volumes.controller"
import { VolumesService } from "./volumes.service"

@Module({
  imports: [OpenFgaModule],
  controllers: [VolumesController],
  providers: [VolumesService],
  exports: [VolumesService],
})
export class VolumesModule {}
