// Load .env from the console monorepo root before anything else reads
// process.env. Single source of truth shared with apps/web.
import { resolve } from "node:path"
import { config as loadDotenv } from "dotenv"
loadDotenv({ path: resolve(__dirname, "../../../.env") })

import { NestFactory } from "@nestjs/core"
import { authPool } from "@workspace/auth"
import { AppModule } from "./app.module"

// Lightweight idempotent migration. Runs on every boot — IF NOT
// EXISTS guards keep it cheap and safe across pod replicas.
async function ensureSchema(): Promise<void> {
  await authPool.query(`
    CREATE TABLE IF NOT EXISTS "branding" (
      id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      color text NOT NULL DEFAULT '',
      text_color text NOT NULL DEFAULT '',
      image_url text NOT NULL DEFAULT '',
      title text NOT NULL DEFAULT 'Console',
      description text NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO "branding" (id) VALUES (1) ON CONFLICT DO NOTHING;
  `)
}

async function bootstrap() {
  await ensureSchema()
  const app = await NestFactory.create(AppModule)

  app.enableCors({
    origin: process.env.WEB_URL ?? "http://localhost:3000",
    credentials: true,
  })

  const port = process.env.PORT ?? 3001
  await app.listen(port)
}

void bootstrap()
