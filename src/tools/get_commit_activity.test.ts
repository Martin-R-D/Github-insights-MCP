import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DB_PATH = ":memory:";
process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_USERNAME = "octocat";
process.env.TIMEZONE = "UTC";

type ToolMod = typeof import("./get_commit_activity.js");
type ReposMod = typeof import("../db/repos.js");
type CommitsMod = typeof import("../db/commits.js");
type SyncStateMod = typeof import("../db/sync_state.js");
type ClientMod = typeof import("../db/client.js");

let getCommitActivityTool: ToolMod["getCommitActivityTool"];
let upsertRepo: ReposMod["upsertRepo"];
let bulkUpsertCommits: CommitsMod["bulkUpsertCommits"];
let upsertSyncState: SyncStateMod["upsertSyncState"];
let db: ClientMod["db"];

const NOW = new Date().toISOString();

function seedRepo(id: number, name: string) {
  upsertRepo({
    id,
    name,
    full_name: `octocat/${name}`,
    owner: "octocat",
    private: 0,
    fork: 0,
    description: null,
    stars: 0,
    forks: 0,
    watchers: 0,
    open_issues: 0,
    primary_language: null,
    size_kb: 0,
    default_branch: "main",
    created_at: null,
    pushed_at: null,
    updated_at: null,
    archived: 0,
    synced_at: NOW,
  });
  // Fresh sync_state so the tool does not attempt a network sync.
  upsertSyncState({ resource: `commits:${id}`, repo_id: id, last_synced_at: NOW });
}

function commit(repoId: number, sha: string, date: string, login = "octocat", adds = 1, dels = 0) {
  return {
    sha,
    repo_id: repoId,
    author_login: login,
    author_email: "o@example.com",
    committed_at: `${date}T12:00:00Z`,
    committed_date: date,
    hour: 12,
    dow: 3,
    additions: adds,
    deletions: dels,
    files_changed: 1,
    message: "work",
  };
}

async function call(args: Record<string, unknown>) {
  const parsed = getCommitActivityTool.inputSchema.parse(args);
  return (await getCommitActivityTool.handler(parsed)) as {
    summary: string;
    data: {
      total_commits: number;
      active_days: number;
      total_days: number;
      quietest_stretch_days: number;
      busiest_day: { date: string | null; commits: number };
      timeline: { bucket: string; commits: number; additions: number; deletions: number }[];
      by_repo: { repo: string; commits: number; percent: number }[];
    };
    meta: { from_cache: boolean; period: { granularity: string } };
  };
}

beforeAll(async () => {
  getCommitActivityTool = (await import("./get_commit_activity.js")).getCommitActivityTool;
  upsertRepo = (await import("../db/repos.js")).upsertRepo;
  bulkUpsertCommits = (await import("../db/commits.js")).bulkUpsertCommits;
  upsertSyncState = (await import("../db/sync_state.js")).upsertSyncState;
  db = (await import("../db/client.js")).db;
});

beforeEach(() => {
  db.exec("DELETE FROM commits; DELETE FROM repos; DELETE FROM sync_state;");
});

describe("gap-filling (day granularity)", () => {
  beforeEach(() => {
    seedRepo(1, "alpha");
    // Commits on Jan 1, Jan 3, Jan 7 only, within a Jan 1..Jan 7 window.
    bulkUpsertCommits([
      commit(1, "a1", "2026-01-01"),
      commit(1, "a2", "2026-01-01"),
      commit(1, "a3", "2026-01-03"),
      commit(1, "a4", "2026-01-07"),
    ]);
  });

  it("emits one bucket per day with zeros for empty days", async () => {
    const res = await call({ start_date: "2026-01-01", end_date: "2026-01-07", granularity: "day" });

    expect(res.data.timeline).toHaveLength(7); // no gaps
    const byBucket = Object.fromEntries(res.data.timeline.map((t) => [t.bucket, t.commits]));
    expect(byBucket["2026-01-01"]).toBe(2);
    expect(byBucket["2026-01-02"]).toBe(0);
    expect(byBucket["2026-01-03"]).toBe(1);
    expect(byBucket["2026-01-07"]).toBe(1);

    expect(res.data.total_commits).toBe(4);
    expect(res.data.active_days).toBe(3);
    expect(res.data.total_days).toBe(7);
    expect(res.data.busiest_day).toEqual({ date: "2026-01-01", commits: 2 });
    // Longest zero run: Jan 4,5,6 => 3 days (Jan 2 is a separate 1-day run).
    expect(res.data.quietest_stretch_days).toBe(3);
    expect(res.meta.from_cache).toBe(true); // fresh sync_state => no sync
  });
});

describe("granularity rollup", () => {
  beforeEach(() => {
    seedRepo(1, "alpha");
    // Week of Mon 2026-01-05: commits on 01-05 and 01-08.
    // Week of Mon 2026-01-19: commit on 01-21. Week of 01-12 has none.
    bulkUpsertCommits([
      commit(1, "w1", "2026-01-05"),
      commit(1, "w2", "2026-01-08"),
      commit(1, "w3", "2026-01-21"),
    ]);
  });

  it("rolls days into Monday-anchored weeks, gap-filled", async () => {
    const res = await call({ start_date: "2026-01-05", end_date: "2026-01-25", granularity: "week" });

    const buckets = res.data.timeline.map((t) => t.bucket);
    expect(buckets).toEqual(["2026-01-05", "2026-01-12", "2026-01-19"]);

    const byBucket = Object.fromEntries(res.data.timeline.map((t) => [t.bucket, t.commits]));
    expect(byBucket["2026-01-05"]).toBe(2); // 01-05 + 01-08
    expect(byBucket["2026-01-12"]).toBe(0); // empty week present
    expect(byBucket["2026-01-19"]).toBe(1); // 01-21
    expect(res.data.total_commits).toBe(3);
  });

  it("rolls days into month buckets", async () => {
    bulkUpsertCommits([commit(1, "m1", "2026-02-14")]);
    const res = await call({ start_date: "2026-01-01", end_date: "2026-03-31", granularity: "month" });

    const buckets = res.data.timeline.map((t) => t.bucket);
    expect(buckets).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    const byBucket = Object.fromEntries(res.data.timeline.map((t) => [t.bucket, t.commits]));
    expect(byBucket["2026-01-01"]).toBe(3);
    expect(byBucket["2026-02-01"]).toBe(1);
    expect(byBucket["2026-03-01"]).toBe(0);
  });
});

describe("filters", () => {
  it("excludes bot commits by default and includes them on request", async () => {
    seedRepo(1, "alpha");
    bulkUpsertCommits([
      commit(1, "h1", "2026-01-02", "octocat"),
      commit(1, "b1", "2026-01-02", "dependabot[bot]"),
    ]);

    const without = await call({ start_date: "2026-01-01", end_date: "2026-01-03" });
    expect(without.data.total_commits).toBe(1);

    const withBots = await call({ start_date: "2026-01-01", end_date: "2026-01-03", include_bots: true });
    expect(withBots.data.total_commits).toBe(2);
  });

  it("splits by_repo with percentages", async () => {
    seedRepo(1, "alpha");
    seedRepo(2, "beta");
    bulkUpsertCommits([
      commit(1, "a", "2026-01-02"),
      commit(1, "b", "2026-01-02"),
      commit(1, "c", "2026-01-02"),
      commit(2, "d", "2026-01-02"),
    ]);
    const res = await call({ start_date: "2026-01-01", end_date: "2026-01-03" });
    const alpha = res.data.by_repo.find((r) => r.repo === "octocat/alpha");
    expect(alpha).toEqual({ repo: "octocat/alpha", commits: 3, percent: 75 });
    expect(res.data.by_repo).toHaveLength(2);
  });
});
