import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DB_PATH = ":memory:";
process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_USERNAME = "octocat";
process.env.TIMEZONE = "UTC";

type ToolMod = typeof import("./get_stars_received.js");
let tool: ToolMod["getStarsReceivedTool"];
let upsertRepo: typeof import("../db/repos.js").upsertRepo;
let bulkUpsertStargazers: typeof import("../db/stars.js").bulkUpsertStargazers;
let db: typeof import("../db/client.js").db;

const DAY_MS = 86_400_000;
const TODAY = new Date().toISOString().slice(0, 10);
function daysAgoTs(n: number): string {
  return new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * DAY_MS).toISOString();
}

function seedRepo(id: number, name: string, stars: number) {
  upsertRepo({
    id, name, full_name: `octocat/${name}`, owner: "octocat", private: 0, fork: 0,
    description: null, stars, forks: 0, watchers: 0, open_issues: 0, primary_language: null,
    size_kb: 0, default_branch: "main", created_at: null, pushed_at: null, updated_at: null,
    archived: 0, synced_at: new Date().toISOString(),
  });
}

async function call(args: Record<string, unknown> = {}) {
  const parsed = tool.inputSchema.parse(args);
  return (await tool.handler(parsed)) as {
    data: {
      total_stars_all_repos: number;
      stars_in_period: number;
      by_repo: { repo: string; stars_in_period: number; growth_percent: number | null }[];
      best_day: { date: string | null; stars_gained: number };
      recent_stargazers: unknown[];
    };
  };
}

beforeAll(async () => {
  tool = (await import("./get_stars_received.js")).getStarsReceivedTool;
  upsertRepo = (await import("../db/repos.js")).upsertRepo;
  bulkUpsertStargazers = (await import("../db/stars.js")).bulkUpsertStargazers;
  db = (await import("../db/client.js")).db;
});

beforeEach(() => {
  db.exec("DELETE FROM repos; DELETE FROM stargazers;");
});

describe("period filtering", () => {
  it("counts only stars within the window", async () => {
    // stars = stored count so no sync is attempted.
    seedRepo(1, "keystrike", 4);
    bulkUpsertStargazers([
      { repo_id: 1, user_login: "a", starred_at: daysAgoTs(2) },
      { repo_id: 1, user_login: "b", starred_at: daysAgoTs(10) },
      { repo_id: 1, user_login: "c", starred_at: daysAgoTs(40) }, // outside 30d
      { repo_id: 1, user_login: "d", starred_at: daysAgoTs(400) }, // outside
    ]);
    const res = await call({ days: 30 });
    expect(res.data.total_stars_all_repos).toBe(4);
    expect(res.data.stars_in_period).toBe(2); // only the 2d + 10d ones
    expect(res.data.best_day.stars_gained).toBe(1);
  });
});

describe("growth_percent zero-division", () => {
  it("returns null (not Infinity) when the starting count was 0", async () => {
    // All 3 stars arrived in-period => starting count = 3 - 3 = 0.
    seedRepo(1, "newrepo", 3);
    bulkUpsertStargazers([
      { repo_id: 1, user_login: "a", starred_at: daysAgoTs(1) },
      { repo_id: 1, user_login: "b", starred_at: daysAgoTs(2) },
      { repo_id: 1, user_login: "c", starred_at: daysAgoTs(3) },
    ]);
    const res = await call({ days: 30 });
    const row = res.data.by_repo.find((r) => r.repo === "octocat/newrepo")!;
    expect(row.stars_in_period).toBe(3);
    expect(row.growth_percent).toBeNull();
    expect(Number.isFinite(row.growth_percent as number)).toBe(false);
  });
});
