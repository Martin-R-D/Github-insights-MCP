import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DB_PATH = ":memory:";
process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_USERNAME = "octocat";
process.env.TIMEZONE = "UTC";

type ToolMod = typeof import("./get_contribution_summary.js");
let tool: ToolMod["getContributionSummaryTool"];
let setCalendarFetcher: ToolMod["__setCalendarFetcher"];
let upsertRepo: typeof import("../db/repos.js").upsertRepo;
let bulkUpsertCommits: typeof import("../db/commits.js").bulkUpsertCommits;
let bulkUpsertPullRequests: typeof import("../db/pulls.js").bulkUpsertPullRequests;
let db: typeof import("../db/client.js").db;

const DAY_MS = 86_400_000;
const TODAY = new Date().toISOString().slice(0, 10);
function toUTC(d: string) {
  const [y, m, da] = d.split("-").map(Number);
  return Date.UTC(y!, m! - 1, da!);
}
function daysAgo(n: number) {
  return new Date(toUTC(TODAY) - n * DAY_MS).toISOString().slice(0, 10);
}

let sha = 0;
function commit(date: string, repoId = 1) {
  return {
    sha: `s${sha++}`, repo_id: repoId, author_login: "octocat", author_email: "o@e.com",
    committed_at: `${date}T12:00:00Z`, committed_date: date, hour: 12, dow: 3,
    additions: 5, deletions: 1, files_changed: 1, message: "w",
  };
}

async function call(args: Record<string, unknown> = {}) {
  const parsed = tool.inputSchema.parse(args);
  return (await tool.handler(parsed)) as {
    data: {
      period: { days: number; start: string; end: string };
      current: { commits: number; contributions_total: number; prs_opened: number };
      previous: { commits: number } | null;
      deltas: { commits: { abs: number; percent: number | null; direction: string } } | null;
      trajectory: { confidence: string };
      weekly_trend: unknown[];
    };
    meta: { note?: string };
  };
}

beforeAll(async () => {
  const mod = await import("./get_contribution_summary.js");
  tool = mod.getContributionSummaryTool;
  setCalendarFetcher = mod.__setCalendarFetcher;
  upsertRepo = (await import("../db/repos.js")).upsertRepo;
  bulkUpsertCommits = (await import("../db/commits.js")).bulkUpsertCommits;
  bulkUpsertPullRequests = (await import("../db/pulls.js")).bulkUpsertPullRequests;
  db = (await import("../db/client.js")).db;
  upsertRepo({
    id: 1, name: "alpha", full_name: "octocat/alpha", owner: "octocat", private: 0, fork: 0,
    description: null, stars: 0, forks: 0, watchers: 0, open_issues: 0, primary_language: null,
    size_kb: 0, default_branch: "main", created_at: null, pushed_at: null, updated_at: null,
    archived: 0, synced_at: new Date().toISOString(),
  });
});

beforeEach(() => {
  db.exec("DELETE FROM commits; DELETE FROM pull_requests; DELETE FROM issues; DELETE FROM stargazers;");
  setCalendarFetcher(async () => []); // deterministic: empty calendar unless overridden
});

afterAll(() => setCalendarFetcher(null));

describe("period boundary math", () => {
  it("uses a previous window equal in days (not calendar month)", async () => {
    // 3 commits in current 30-day window, 1 in the previous 30-day window.
    bulkUpsertCommits([commit(daysAgo(1)), commit(daysAgo(5)), commit(daysAgo(20))]);
    bulkUpsertCommits([commit(daysAgo(40))]); // within prev window (30..59 ago)
    bulkUpsertCommits([commit(daysAgo(80))]); // outside both

    const res = await call({ period: "month" });
    expect(res.data.period.days).toBe(30);
    expect(res.data.current.commits).toBe(3);
    expect(res.data.previous!.commits).toBe(1);
    expect(res.data.deltas!.commits.abs).toBe(2);
    expect(res.data.deltas!.commits.percent).toBe(200); // (3-1)/1
    expect(res.data.deltas!.commits.direction).toBe("up");
  });
});

describe("zero-division guard", () => {
  it("returns null percent when the previous window had zero", async () => {
    bulkUpsertCommits([commit(daysAgo(2)), commit(daysAgo(3))]); // current only
    const res = await call({ period: "month" });
    expect(res.data.previous!.commits).toBe(0);
    expect(res.data.deltas!.commits.percent).toBeNull();
    expect(res.data.deltas!.commits.direction).toBe("up");
  });
});

describe("low-confidence trajectory", () => {
  it("hedges when there are fewer than 6 weekly points", async () => {
    bulkUpsertCommits([commit(daysAgo(2)), commit(daysAgo(9))]);
    const res = await call({ period: "month" }); // ~5 weeks => < 6 points
    expect(res.data.weekly_trend.length).toBeLessThan(6);
    expect(res.data.trajectory.confidence).toBe("low");
  });
});

describe("contribution calendar merge", () => {
  it("sums the injected calendar for contributions_total (covers private work)", async () => {
    bulkUpsertCommits([commit(daysAgo(2))]);
    setCalendarFetcher(async () => [
      { date: daysAgo(2), count: 4 },
      { date: daysAgo(3), count: 6 },
      { date: daysAgo(100), count: 99 }, // outside current window
    ]);
    const res = await call({ period: "month", compare_to_previous: false });
    expect(res.data.current.contributions_total).toBe(10); // 4 + 6, not 99
  });

  it("falls back to commits and notes when the calendar is unavailable", async () => {
    bulkUpsertCommits([commit(daysAgo(2)), commit(daysAgo(4))]);
    setCalendarFetcher(async () => {
      throw new Error("graphql down");
    });
    const res = await call({ period: "month", compare_to_previous: false });
    expect(res.data.current.contributions_total).toBe(2); // == commits
    expect(res.meta.note).toMatch(/calendar unavailable/i);
  });
});
