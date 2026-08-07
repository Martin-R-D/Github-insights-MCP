import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Import the schema-level behavior by re-loading the module with a fresh env.
// loadConfig caches, so we reset modules between cases.
const ORIGINAL_ENV = { ...process.env };

async function loadFresh() {
  vi.resetModules();
  const mod = await import("./config.js");
  return mod.loadConfig;
}

describe("loadConfig", () => {
  beforeEach(() => {
    // Start from a clean slate for the variables under test.
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_USERNAME;
    delete process.env.TIMEZONE;
    delete process.env.DB_PATH;
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("parses a valid environment and applies defaults", async () => {
    process.env.GITHUB_TOKEN = "ghp_example";
    process.env.GITHUB_USERNAME = "octocat";

    const loadConfig = await loadFresh();
    const config = loadConfig();

    expect(config.GITHUB_TOKEN).toBe("ghp_example");
    expect(config.GITHUB_USERNAME).toBe("octocat");
    expect(config.TIMEZONE).toBe("UTC");
    expect(config.DB_PATH).toBe("./data/github.db");
    expect(config.LOG_LEVEL).toBe("info");
  });

  it("lists every missing required variable in one message", async () => {
    const loadConfig = await loadFresh();
    expect(() => loadConfig()).toThrow(/GITHUB_TOKEN/);
    try {
      loadConfig();
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/GITHUB_TOKEN/);
      expect(msg).toMatch(/GITHUB_USERNAME/);
    }
  });

  it("rejects an invalid IANA time zone", async () => {
    process.env.GITHUB_TOKEN = "ghp_example";
    process.env.GITHUB_USERNAME = "octocat";
    process.env.TIMEZONE = "Not/AZone";

    const loadConfig = await loadFresh();
    expect(() => loadConfig()).toThrow(/TIMEZONE/);
  });

  it("accepts a real IANA time zone", async () => {
    process.env.GITHUB_TOKEN = "ghp_example";
    process.env.GITHUB_USERNAME = "octocat";
    process.env.TIMEZONE = "America/New_York";

    const loadConfig = await loadFresh();
    expect(loadConfig().TIMEZONE).toBe("America/New_York");
  });
});
