import { copyFileSync, mkdirSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/bin/sync.ts"],
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
  // client.ts reads schema.sql relative to its own bundled file at runtime.
  // Each entry bundles client.ts into its own directory, so place the SQL next
  // to every emitted entry (dist/ for index.js, dist/bin/ for sync.js).
  async onSuccess() {
    copyFileSync("src/db/schema.sql", "dist/schema.sql");
    mkdirSync("dist/bin", { recursive: true });
    copyFileSync("src/db/schema.sql", "dist/bin/schema.sql");
  },
});
