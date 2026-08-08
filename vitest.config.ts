import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Each test file imports the native better-sqlite3 binding (and some import
    // Octokit). Running many in parallel on Windows can make cold-start imports
    // exceed the default 10s hook timeout, so give hooks/tests more headroom.
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
