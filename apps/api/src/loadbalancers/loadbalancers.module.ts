import { Module } from "@nestjs/common"
import { OpenFgaModule } from "../openfga/openfga.module"
import { LoadBalancersController } from "./loadbalancers.controller"
import { LoadBalancersService } from "./loadbalancers.service"

@Module({
  imports: [OpenFgaModule],
  controllers: [LoadBalancersController],
  providers: [LoadBalancersService],
  exports: [LoadBalancersService],
})
export class LoadBalancersModule {}
