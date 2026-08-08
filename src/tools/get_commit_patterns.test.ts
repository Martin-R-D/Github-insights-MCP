import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DB_PATH = ":memory:";
process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_USERNAME = "octocat";
process.env.TIMEZONE = "UTC";

type ToolMod = typeof import("./get_commit_patterns.js");
type CommitsMod = typeof import("../db/commits.js");
type ClientMod = typeof import("../db/client.js");

let getCommitPatternsTool: ToolMod["getCommitPatternsTool"];
let bulkUpsertCommits: CommitsMod["bulkUpsertCommits"];
let db: ClientMod["db"];

const DAY_MS = 86_400_000;
function toUTC(d: string): number {
  const [y, m, day] = d.split("-").map(Number);
  return Date.UTC(y!, m! - 1, day!);
}
function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
const TODAY = ymd(Date.now());
function daysAgo(n: number): string {
  return ymd(toUTC(TODAY) - n * DAY_MS);
}

let sha = 0;
function commit(date: string, hour = 22, login = "octocat") {
  const dow = new Date(toUTC(date)).getUTCDay();
  return {
    sha: `s${sha++}`,
    repo_id: 1,
    author_login: login,
    author_email: "o@example.com",
    committed_at: `${date}T${String(hour).padStart(2, "0")}:00:00Z`,
    committed_date: date,
    hour,
    dow,
    additions: 1,
    deletions: 0,
    files_changed: 1,
    message: "work",
  };
}

async function call(args: Record<string, unknown> = {}) {
  const parsed = getCommitPatternsTool.inputSchema.parse(args);
  return (await getCommitPatternsTool.handler(parsed)) as {
    summary: string;
    data: {
      streaks: {
        current_streak_days: number;
        current_streak_start: string | null;
        longest_streak_days: number;
        longest_streak_start: string | null;
        longest_streak_end: string | null;
        top_streaks: { start: string; end: string; days: number; commits: number }[];
      };
      by_day_of_week: { day: string; percent: number; avg_per_occurrence: number }[];
      by_hour: { hour: number; percent: number }[];
      peak: { day_of_week: string | null; hour: number | null; hour_label: string | null };
      weekday_vs_weekend: { weekend_percent: number };
    };
  };
}

beforeAll(async () => {
  getCommitPatternsTool = (await import("./get_commit_patterns.js")).getCommitPatternsTool;
  bulkUpsertCommits = (await import("../db/commits.js")).bulkUpsertCommits;
  db = (await import("../db/client.js")).db;
});

beforeEach(() => {
  db.exec("DELETE FROM commits;");
});

describe("streaks", () => {
  it("counts a single-day streak as length 1", async () => {
    const day = daysAgo(100); // isolated, not today/yesterday
    bulkUpsertCommits([commit(day)]);
    const res = await call();
    expect(res.data.streaks.longest_streak_days).toBe(1);
    expect(res.data.streaks.longest_streak_start).toBe(day);
    expect(res.data.streaks.longest_streak_end).toBe(day);
    expect(res.data.streaks.current_streak_days).toBe(0); // not today/yesterday
  });

  it("breaks the streak on a single gap day", async () => {
    // A, A+1 (len 2), gap at A+2, then A+3, A+4, A+5 (len 3).
    const a = daysAgo(200);
    bulkUpsertCommits([
      commit(a),
      commit(ymd(toUTC(a) + 1 * DAY_MS)),
      commit(ymd(toUTC(a) + 3 * DAY_MS)),
      commit(ymd(toUTC(a) + 4 * DAY_MS)),
      commit(ymd(toUTC(a) + 5 * DAY_MS)),
    ]);
    const res = await call();
    expect(res.data.streaks.longest_streak_days).toBe(3);
    expect(res.data.streaks.longest_streak_start).toBe(ymd(toUTC(a) + 3 * DAY_MS));
    expect(res.data.streaks.longest_streak_end).toBe(ymd(toUTC(a) + 5 * DAY_MS));
    expect(res.data.streaks.top_streaks.map((s) => s.days)).toEqual([3, 2]);
  });

  it("counts a streak ending yesterday as current", async () => {
    const dayBeforeYesterday = daysAgo(2);
    const yesterday = daysAgo(1);
    bulkUpsertCommits([commit(dayBeforeYesterday), commit(yesterday)]);
    const res = await call();
    expect(res.data.streaks.current_streak_days).toBe(2);
    expect(res.data.streaks.current_streak_start).toBe(dayBeforeYesterday);
  });

  it("counts a streak ending today as current", async () => {
    bulkUpsertCommits([commit(daysAgo(1)), commit(TODAY)]);
    const res = await call();
    expect(res.data.streaks.current_streak_days).toBe(2);
    expect(res.data.streaks.current_streak_start).toBe(daysAgo(1));
  });
});

describe("empty data", () => {
  it("returns zeros, not NaN", async () => {
    const res = await call();
    const s = res.data.streaks;
    expect(s.current_streak_days).toBe(0);
    expect(s.longest_streak_days).toBe(0);
    expect(s.longest_streak_start).toBeNull();
    expect(s.top_streaks).toEqual([]);
    expect(res.data.peak.day_of_week).toBeNull();
    expect(res.data.peak.hour).toBeNull();
    expect(res.data.weekday_vs_weekend.weekend_percent).toBe(0);
    // No NaN anywhere in percent/avg fields.
    for (const d of res.data.by_day_of_week) {
      expect(Number.isNaN(d.percent)).toBe(false);
      expect(Number.isNaN(d.avg_per_occurrence)).toBe(false);
    }
    for (const h of res.data.by_hour) expect(Number.isNaN(h.percent)).toBe(false);
    expect(res.summary).toMatch(/No commits/);
  });
});

describe("distribution", () => {
  it("attributes commits to the right weekday and hour peak", async () => {
    // Three commits on a known Tuesday (2026-01-06) at 22:00 (10 PM).
    const tuesday = "2026-01-06"; // within the last 365 days if run in 2026; use explicit past dates
    // Use dates guaranteed in-window: pick recent Tuesdays relative to today.
    const someTuesday = (() => {
      let d = toUTC(TODAY);
      while (new Date(d).getUTCDay() !== 2) d -= DAY_MS;
      return ymd(d);
    })();
    void tuesday;
    bulkUpsertCommits([commit(someTuesday, 22), commit(someTuesday, 22), commit(someTuesday, 22)]);
    const res = await call();
    expect(res.data.peak.day_of_week).toBe("Tuesday");
    expect(res.data.peak.hour).toBe(22);
    expect(res.data.peak.hour_label).toBe("10 PM");
    const tue = res.data.by_day_of_week.find((d) => d.day === "Tuesday")!;
    expect(tue.percent).toBe(100);
  });
});
