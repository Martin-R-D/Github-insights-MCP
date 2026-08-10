import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DB_PATH = ":memory:";
process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_USERNAME = "octocat";
process.env.TIMEZONE = "UTC";

type Mod = typeof import("./report.js");
let generateWeeklyReport: Mod["generateWeeklyReport"];
let resolveWeek: Mod["resolveWeek"];
let setSyncRunner: Mod["__setSyncRunner"];
let upsertRepo: typeof import("../db/repos.js").upsertRepo;
let bulkUpsertCommits: typeof import("../db/commits.js").bulkUpsertCommits;
let upsertSyncState: typeof import("../db/sync_state.js").upsertSyncState;
let db: typeof import("../db/client.js").db;

function utcDow(d: string): number {
  const [y, m, da] = d.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, da!)).getUTCDay();
}

beforeAll(async () => {
  const mod = await import("./report.js");
  generateWeeklyReport = mod.generateWeeklyReport;
  resolveWeek = mod.resolveWeek;
  setSyncRunner = mod.__setSyncRunner;
  upsertRepo = (await import("../db/repos.js")).upsertRepo;
  bulkUpsertCommits = (await import("../db/commits.js")).bulkUpsertCommits;
  upsertSyncState = (await import("../db/sync_state.js")).upsertSyncState;
  db = (await import("../db/client.js")).db;
});

afterAll(() => setSyncRunner(null));

describe("resolveWeek boundary math", () => {
  it("returns Monday..Sunday around a month edge and offsets by whole weeks", () => {
    const today = "2026-08-05"; // a Wednesday

    const w0 = resolveWeek({ week_offset: 0 }, today);
    expect(utcDow(w0.start)).toBe(1); // Monday
    expect(utcDow(w0.end)).toBe(0); // Sunday
    expect(w0.start <= today && today <= w0.end).toBe(true);
    expect(w0.label).toMatch(/^[A-Z][a-z]{2} \d+ - [A-Z][a-z]{2} \d+, 2026$/);

    // Offset 1 = the immediately preceding week, and it crosses the month edge.
    const w1 = resolveWeek({ week_offset: 1 }, today);
    expect(utcDow(w1.start)).toBe(1);
    const diffDays = (Date.parse(w0.start) - Date.parse(w1.start)) / 86_400_000;
    expect(diffDays).toBe(7);
    expect(w1.label).toMatch(/Jul .* - Aug .*, 2026/); // month edge

    // Offset 2 = two weeks back.
    const w2 = resolveWeek({ week_offset: 2 }, today);
    expect((Date.parse(w0.start) - Date.parse(w2.start)) / 86_400_000).toBe(14);
  });

  it("honors explicit start_date/end_date overrides", () => {
    const w = resolveWeek({ start_date: "2026-03-02", end_date: "2026-03-08" }, "2026-08-05");
    expect(w.start).toBe("2026-03-02");
    expect(w.end).toBe("2026-03-08");
    expect(w.label).toBe("Mar 2 - Mar 8, 2026");
  });
});

describe("generateWeeklyReport", () => {
  beforeEach(() => {
    db.exec("DELETE FROM repos; DELETE FROM commits; DELETE FROM sync_state; DELETE FROM stargazers; DELETE FROM pull_requests; DELETE FROM issues;");
    // Fresh sync_state so the fan-out skips syncAll (no network).
    upsertSyncState({ resource: "repos", last_synced_at: new Date().toISOString() });
    setSyncRunner(async () => {
      throw new Error("sync should not run when recently synced");
    });
    upsertRepo({
      id: 1, name: "keystrike", full_name: "octocat/keystrike", owner: "octocat", private: 0, fork: 0,
      description: null, stars: 0, forks: 0, watchers: 0, open_issues: 0, primary_language: "TypeScript",
      size_kb: 0, default_branch: "main", created_at: null, pushed_at: null, updated_at: null,
      archived: 0, synced_at: new Date().toISOString(),
    });
    bulkUpsertCommits([
      { sha: "a", repo_id: 1, author_login: "octocat", author_email: "o@e.com", committed_at: "2026-08-04T10:00:00Z", committed_date: "2026-08-04", hour: 10, dow: 2, additions: 10, deletions: 2, files_changed: 1, message: "feat: add thing\n\nbody" },
      { sha: "b", repo_id: 1, author_login: "octocat", author_email: "o@e.com", committed_at: "2026-08-05T14:00:00Z", committed_date: "2026-08-05", hour: 14, dow: 3, additions: 3, deletions: 1, files_changed: 1, message: "fix: tweak" },
    ]);
  });

  it("degrades gracefully when one section rejects (partial_failures)", async () => {
    const res = await generateWeeklyReport({
      start_date: "2026-08-03",
      end_date: "2026-08-09",
      sectionOverrides: {
        by_repo: async () => {
          throw new Error("boom");
        },
      },
    });

    // The failing section is null and listed; others still produced data.
    expect(res.data.by_repo).toBeNull();
    expect(res.meta.partial_failures).toContain("by_repo");
    expect((res.data.headline as { commits: number }).commits).toBe(2);
    expect(res.meta.from_cache).toBe(true); // sync skipped
    expect(typeof res.summary).toBe("string");
    expect(res.summary.length).toBeGreaterThan(0);
  });

  it("produces markdown with the required sections and no em dashes", async () => {
    const res = await generateWeeklyReport({ start_date: "2026-08-03", end_date: "2026-08-09", format: "markdown" });
    const md = res.data.markdown as string;
    expect(md).toContain("## Headline");
    expect(md).toContain("## What shipped");
    expect(md).toContain("## Where the work went");
    expect(md).toContain("## Patterns");
    expect(md).toContain("## Community");
    expect(md).toContain("## Needs attention");
    expect(md).not.toMatch(/—/); // no em dash
    expect(md).toContain("Commits: 2");
  });
});
