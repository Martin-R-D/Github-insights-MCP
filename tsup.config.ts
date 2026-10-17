import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

export default defineConfig({
  entry: ["src/index.ts", "src/scripts/sync-cron.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  define: { __APP_VERSION__: JSON.stringify(version) },
  // better-sqlite3 ships a native binding; keep it external so the prebuilt
  // .node file is required from node_modules at runtime rather than bundled.
  external: ["better-sqlite3"],
  banner: {
    js: "#!/usr/bin/env node",
  },
  // client.ts reads schema.sql relative to its own bundled file at runtime.
  // Each entry bundles client.ts into its own directory, so place the SQL next
  // to every emitted entry (dist/ for index.js, dist/scripts/ for sync-cron.js).
  async onSuccess() {
    copyFileSync("src/db/schema.sql", "dist/schema.sql");
    mkdirSync("dist/scripts", { recursive: true });
    copyFileSync("src/db/schema.sql", "dist/scripts/schema.sql");
  },
});
