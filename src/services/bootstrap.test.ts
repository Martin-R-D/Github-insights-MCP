import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DB_PATH = ":memory:";
process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_USERNAME = "octocat";

type Mod = typeof import("./bootstrap.js");
let bootstrap: Mod;
let upsertRepo: typeof import("../db/repos.js").upsertRepo;
let db: typeof import("../db/client.js").db;

beforeAll(async () => {
  bootstrap = await import("./bootstrap.js");
  upsertRepo = (await import("../db/repos.js")).upsertRepo;
  db = (await import("../db/client.js")).db;
});

beforeEach(() => {
  db.exec("DELETE FROM repos;");
});

describe("first-run bootstrap", () => {
  it("reports the DB empty when no repos exist", () => {
    expect(bootstrap.isDbEmpty()).toBe(true);
  });

  it("does not start an initial sync when repos already exist", () => {
    upsertRepo({
      id: 1, name: "x", full_name: "octocat/x", owner: "octocat", private: 0, fork: 0,
      description: null, stars: 0, forks: 0, watchers: 0, open_issues: 0, primary_language: null,
      size_kb: 0, default_branch: "main", created_at: null, pushed_at: null, updated_at: null,
      archived: 0, synced_at: new Date().toISOString(),
    });
    expect(bootstrap.isDbEmpty()).toBe(false);
    bootstrap.startInitialSyncIfEmpty(); // no-op: not empty, so no network sync
    expect(bootstrap.firstRunActive()).toBe(false);
  });

  it("stillSyncingResponse has a friendly shape with progress", () => {
    const r = bootstrap.stillSyncingResponse();
    expect(r.data).toBeNull();
    expect(r.meta.syncing).toBe(true);
    expect(typeof r.meta.repos_done).toBe("number");
    expect(r.summary).toMatch(/syncing/i);
  });
});
