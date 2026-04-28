import { Module } from "@nestjs/common"
import { VmsController } from "./vms.controller"
import { VmsService } from "./vms.service"

@Module({
  controllers: [VmsController],
  providers: [VmsService],
})
export class VmsModule {}
