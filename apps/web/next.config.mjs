import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { config as loadDotenv } from "dotenv"

// Load the monorepo-root .env so both apps and the shared @workspace/auth
// package read identical values without per-app env duplication.
const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, "../../.env") })

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained server build for the production Docker image. Outputs
  // .next/standalone/{apps/web/server.js,node_modules,.next} including only
  // files that file-tracing actually needs.
  output: "standalone",
  // Tell file-tracing the workspace root is two levels up — without this
  // it traces from apps/web and misses @workspace/auth's transitive deps.
  outputFileTracingRoot: resolve(__dirname, "../.."),
  transpilePackages: ["@workspace/ui"],
}

export default nextConfig
