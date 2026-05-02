import { Module } from "@nestjs/common"
import { HarborClient } from "./harbor.client"

@Module({
  providers: [HarborClient],
  exports: [HarborClient],
})
export class HarborModule {}
