import { copyFileSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  // better-sqlite3 ships a native binding; keep it external so the prebuilt
  // .node file is required from node_modules at runtime rather than bundled.
  external: ["better-sqlite3"],
  banner: {
    js: "#!/usr/bin/env node",
  },
  // client.ts reads schema.sql relative to its own file at runtime. In the
  // bundle that resolves to dist/, so copy the SQL there after each build.
  async onSuccess() {
    copyFileSync("src/db/schema.sql", "dist/schema.sql");
  },
});
