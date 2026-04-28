// Load .env from the console monorepo root before anything else reads
// process.env. Single source of truth shared with apps/web.
import { resolve } from "node:path"
import { config as loadDotenv } from "dotenv"
loadDotenv({ path: resolve(__dirname, "../../../.env") })

import { NestFactory } from "@nestjs/core"
import { AppModule } from "./app.module"

async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  app.enableCors({
    origin: process.env.WEB_URL ?? "http://localhost:3000",
    credentials: true,
  })

  const port = process.env.PORT ?? 3001
  await app.listen(port)
}

void bootstrap()
