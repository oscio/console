import { Module } from "@nestjs/common"
import { ForgejoClient } from "./forgejo.client"

@Module({
  providers: [ForgejoClient],
  exports: [ForgejoClient],
})
export class ForgejoModule {}
