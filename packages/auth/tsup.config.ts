import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/env.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  external: ["pg", "better-auth", "react"],
})
