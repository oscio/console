import { Global, Module } from "@nestjs/common"
import { OpenFgaService } from "./openfga.service"

// Global so AdminGuard / RoleBindingsService / future per-resource guards
// don't each have to import the OpenFga module explicitly.
@Global()
@Module({
  providers: [OpenFgaService],
  exports: [OpenFgaService],
})
export class OpenFgaModule {}
