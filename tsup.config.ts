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
});
