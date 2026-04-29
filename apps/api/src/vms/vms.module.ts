import { Module } from "@nestjs/common"
import { LoadBalancersModule } from "../loadbalancers/loadbalancers.module"
import { OpenFgaModule } from "../openfga/openfga.module"
import { VolumesModule } from "../volumes/volumes.module"
import { VmsAuthController, VmsController } from "./vms.controller"
import { VmsService } from "./vms.service"

@Module({
  imports: [OpenFgaModule, VolumesModule, LoadBalancersModule],
  controllers: [VmsController, VmsAuthController],
  providers: [VmsService],
})
export class VmsModule {}
