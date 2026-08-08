import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DB_PATH = ":memory:";
process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_USERNAME = "octocat";
process.env.TIMEZONE = "UTC";

type ToolMod = typeof import("./get_repo_stats.js");
type Mods = {
  upsertRepo: typeof import("../db/repos.js").upsertRepo;
  bulkUpsertCommits: typeof import("../db/commits.js").bulkUpsertCommits;
  bulkUpsertLanguages: typeof import("../db/languages.js").bulkUpsertLanguages;
  bulkUpsertStargazers: typeof import("../db/stars.js").bulkUpsertStargazers;
  bulkUpsertPullRequests: typeof import("../db/pulls.js").bulkUpsertPullRequests;
  bulkUpsertIssues: typeof import("../db/issues.js").bulkUpsertIssues;
  writeDailySnapshot: typeof import("../db/snapshots.js").writeDailySnapshot;
  upsertSyncState: typeof import("../db/sync_state.js").upsertSyncState;
  db: typeof import("../db/client.js").db;
};

let getRepoStatsTool: ToolMod["getRepoStatsTool"];
let m: Mods;

const DAY_MS = 86_400_000;
const TODAY = new Date().toISOString().slice(0, 10);
function toUTC(d: string) {
  const [y, mo, da] = d.split("-").map(Number);
  return Date.UTC(y!, mo! - 1, da!);
}
function daysAgo(n: number) {
  return new Date(toUTC(TODAY) - n * DAY_MS).toISOString().slice(0, 10);
}
const NOW = new Date().toISOString();

let sha = 0;
function seedRepo(id: number, name: string, stars: number, extra: Partial<Record<string, unknown>> = {}) {
  m.upsertRepo({
    id,
    name,
    full_name: `octocat/${name}`,
    owner: "octocat",
    private: 0,
    fork: 0,
    description: "demo",
    stars,
    forks: 12,
    watchers: 30,
    open_issues: 4,
    primary_language: "TypeScript",
    size_kb: 500,
    default_branch: "main",
    created_at: "2024-01-01T00:00:00Z",
    pushed_at: daysAgo(2) + "T00:00:00Z",
    updated_at: NOW,
    archived: 0,
    synced_at: NOW,
    ...extra,
  });
  // Fresh sync_state for all four resources => no network sync.
  for (const res of ["commits", "languages", "stargazers", "pulls_issues"]) {
    m.upsertSyncState({ resource: `${res}:${id}`, repo_id: id, last_synced_at: NOW });
  }
}

function commit(repoId: number, date: string) {
  return {
    sha: `s${sha++}`,
    repo_id: repoId,
    author_login: "octocat",
    author_email: "o@example.com",
    committed_at: `${date}T12:00:00Z`,
    committed_date: date,
    hour: 12,
    dow: 3,
    additions: 10,
    deletions: 2,
    files_changed: 1,
    message: "work",
  };
}

async function call(args: Record<string, unknown>) {
  const parsed = getRepoStatsTool.inputSchema.parse(args);
  return (await getRepoStatsTool.handler(parsed)) as {
    summary: string;
    data: {
      repo: { name: string; url: string | null };
      social: { stars: number; stars_gained_in_period: number; star_growth_percent: number | null };
      activity: { commits_in_period: number; commits_all_time: number; active_days: number; days_since_last_commit: number | null };
      issues: { open: number; closed_in_period: number; avg_days_to_close: number | null };
      pull_requests: { open: number; merged_in_period: number; avg_days_to_merge: number | null };
      languages: { language: string; percent: number }[];
      trend: { date: string; stars: number }[];
    };
    meta: { from_cache: boolean; note?: string };
  };
}

beforeAll(async () => {
  getRepoStatsTool = (await import("./get_repo_stats.js")).getRepoStatsTool;
  m = {
    upsertRepo: (await import("../db/repos.js")).upsertRepo,
    bulkUpsertCommits: (await import("../db/commits.js")).bulkUpsertCommits,
    bulkUpsertLanguages: (await import("../db/languages.js")).bulkUpsertLanguages,
    bulkUpsertStargazers: (await import("../db/stars.js")).bulkUpsertStargazers,
    bulkUpsertPullRequests: (await import("../db/pulls.js")).bulkUpsertPullRequests,
    bulkUpsertIssues: (await import("../db/issues.js")).bulkUpsertIssues,
    writeDailySnapshot: (await import("../db/snapshots.js")).writeDailySnapshot,
    upsertSyncState: (await import("../db/sync_state.js")).upsertSyncState,
    db: (await import("../db/client.js")).db,
  };
});

beforeEach(() => {
  m.db.exec(
    "DELETE FROM repos; DELETE FROM commits; DELETE FROM repo_languages; DELETE FROM stargazers; " +
      "DELETE FROM pull_requests; DELETE FROM issues; DELETE FROM daily_snapshots; DELETE FROM sync_state;",
  );
});

describe("get_repo_stats aggregation", () => {
  beforeEach(() => {
    seedRepo(1, "keystrike", 214);
    m.bulkUpsertCommits([commit(1, daysAgo(3)), commit(1, daysAgo(3)), commit(1, daysAgo(10))]);
    m.bulkUpsertLanguages(1, { TypeScript: 780, CSS: 220 });
    // Two snapshots => growth computable: baseline 196 -> current 214 = +18 (+9.2%).
    m.writeDailySnapshot({ date: daysAgo(80), repo_id: 1, stars: 196, forks: 10, open_issues: 4, commits_count: 0 });
    m.writeDailySnapshot({ date: daysAgo(1), repo_id: 1, stars: 214, forks: 12, open_issues: 4, commits_count: 1 });
    // Issues: 1 open, 1 closed in period (5 days to close).
    m.bulkUpsertIssues([
      { id: 11, repo_id: 1, number: 1, state: "open", title: "a", author_login: "x", created_at: daysAgo(20) + "T00:00:00Z", closed_at: null, is_pull_request: 0 },
      { id: 12, repo_id: 1, number: 2, state: "closed", title: "b", author_login: "x", created_at: daysAgo(15) + "T00:00:00Z", closed_at: daysAgo(10) + "T00:00:00Z", is_pull_request: 0 },
    ]);
    // PRs: 2 open, 1 merged in period (4 days to merge).
    m.bulkUpsertPullRequests([
      { id: 21, repo_id: 1, number: 3, state: "open", title: "p", author_login: "x", created_at: daysAgo(5) + "T00:00:00Z", merged_at: null, closed_at: null, additions: 1, deletions: 0 },
      { id: 22, repo_id: 1, number: 4, state: "open", title: "q", author_login: "x", created_at: daysAgo(6) + "T00:00:00Z", merged_at: null, closed_at: null, additions: 1, deletions: 0 },
      { id: 23, repo_id: 1, number: 5, state: "closed", title: "r", author_login: "x", created_at: daysAgo(12) + "T00:00:00Z", merged_at: daysAgo(8) + "T00:00:00Z", closed_at: daysAgo(8) + "T00:00:00Z", additions: 1, deletions: 0 },
    ]);
  });

  it("aggregates social, activity, issues, PRs and languages", async () => {
    const res = await call({ repo: "keystrike", days: 90 });

    expect(res.data.repo.url).toBe("https://github.com/octocat/keystrike");
    expect(res.data.social.stars).toBe(214);
    expect(res.data.social.stars_gained_in_period).toBe(18);
    expect(res.data.social.star_growth_percent).toBe(9.2);

    expect(res.data.activity.commits_in_period).toBe(3);
    expect(res.data.activity.commits_all_time).toBe(3);
    expect(res.data.activity.active_days).toBe(2);

    expect(res.data.issues.open).toBe(1);
    expect(res.data.issues.closed_in_period).toBe(1);
    expect(res.data.issues.avg_days_to_close).toBe(5);

    expect(res.data.pull_requests.open).toBe(2);
    expect(res.data.pull_requests.merged_in_period).toBe(1);
    expect(res.data.pull_requests.avg_days_to_merge).toBe(4);

    expect(res.data.languages[0]).toEqual({ language: "TypeScript", bytes: 780, percent: 78 });
    expect(res.data.trend).toHaveLength(2);
    expect(res.meta.from_cache).toBe(true);
    expect(res.meta.note).toBeUndefined();
    expect(res.summary).toContain("214 stars (+18 in 90d, +9.2%)");
    expect(res.summary).toContain("78% TypeScript");
  });
});

describe("no snapshot history yet", () => {
  it("returns null growth with a note and falls back to star events", async () => {
    seedRepo(1, "fresh", 50);
    // Only one snapshot => not enough for growth %.
    m.writeDailySnapshot({ date: daysAgo(1), repo_id: 1, stars: 50, forks: 1, open_issues: 0, commits_count: 0 });
    // 3 star events within the period.
    m.bulkUpsertStargazers([
      { repo_id: 1, user_login: "u1", starred_at: daysAgo(10) + "T00:00:00Z" },
      { repo_id: 1, user_login: "u2", starred_at: daysAgo(5) + "T00:00:00Z" },
      { repo_id: 1, user_login: "u3", starred_at: daysAgo(2) + "T00:00:00Z" },
    ]);

    const res = await call({ repo: "fresh" });
    expect(res.data.social.star_growth_percent).toBeNull();
    expect(res.data.social.stars_gained_in_period).toBe(3); // from star events
    expect(res.meta.note).toMatch(/trend history/i);
  });
});

describe("resolution", () => {
  it("resolves an exact full_name", async () => {
    seedRepo(1, "keystrike", 10);
    const res = await call({ repo: "octocat/keystrike" });
    expect(res.data.repo.name).toBe("keystrike");
  });

  it("errors and lists candidates when the fuzzy match is ambiguous", async () => {
    seedRepo(1, "alpha-api", 1);
    seedRepo(2, "beta-api", 2);
    await expect(call({ repo: "api" })).rejects.toThrow(/matches 2 repos/i);
  });

  it("errors when nothing matches", async () => {
    seedRepo(1, "keystrike", 1);
    await expect(call({ repo: "nonexistent" })).rejects.toThrow(/No repo matching/i);
  });
});
