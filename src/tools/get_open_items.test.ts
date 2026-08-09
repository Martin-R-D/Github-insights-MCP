import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DB_PATH = ":memory:";
process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_USERNAME = "octocat";
process.env.TIMEZONE = "UTC";

type ToolMod = typeof import("./get_open_items.js");
let tool: ToolMod["getOpenItemsTool"];
let upsertRepo: typeof import("../db/repos.js").upsertRepo;
let bulkUpsertPullRequests: typeof import("../db/pulls.js").bulkUpsertPullRequests;
let bulkUpsertIssues: typeof import("../db/issues.js").bulkUpsertIssues;
let db: typeof import("../db/client.js").db;

const DAY_MS = 86_400_000;
const NOW = Date.now();
function daysAgoTs(n: number) {
  return new Date(NOW - n * DAY_MS).toISOString();
}

function seedRepo(id: number, name: string) {
  upsertRepo({
    id, name, full_name: `octocat/${name}`, owner: "octocat", private: 0, fork: 0,
    description: null, stars: 0, forks: 0, watchers: 0, open_issues: 0, primary_language: null,
    size_kb: 0, default_branch: "main", created_at: null, pushed_at: null, updated_at: null,
    archived: 0, synced_at: new Date().toISOString(),
  });
}

async function call(args: Record<string, unknown> = {}) {
  const parsed = tool.inputSchema.parse(args);
  return (await tool.handler(parsed)) as {
    data: {
      open_prs: { number: number; is_stale: boolean; days_open: number }[];
      open_issues: { number: number; labels: string[]; is_stale: boolean }[];
      needs_attention: { type: string; repo: string; number: number; reason: string }[];
      counts: { open_prs: number; open_issues: number; stale_prs: number; stale_issues: number; from_others: number };
    };
  };
}

beforeAll(async () => {
  tool = (await import("./get_open_items.js")).getOpenItemsTool;
  upsertRepo = (await import("../db/repos.js")).upsertRepo;
  bulkUpsertPullRequests = (await import("../db/pulls.js")).bulkUpsertPullRequests;
  bulkUpsertIssues = (await import("../db/issues.js")).bulkUpsertIssues;
  db = (await import("../db/client.js")).db;
});

beforeEach(() => {
  db.exec("DELETE FROM repos; DELETE FROM pull_requests; DELETE FROM issues;");
  seedRepo(1, "keystrike");
});

describe("stale and needs_attention classification", () => {
  beforeEach(() => {
    bulkUpsertPullRequests([
      // Stale PR (21 days > 14), authored by someone else.
      { id: 1, repo_id: 1, number: 101, state: "open", title: "Add feature", author_login: "contributor", created_at: daysAgoTs(21), merged_at: null, closed_at: null, additions: 1, deletions: 0 },
      // Fresh PR by me.
      { id: 2, repo_id: 1, number: 102, state: "open", title: "Tweak", author_login: "octocat", created_at: daysAgoTs(2), merged_at: null, closed_at: null, additions: 1, deletions: 0 },
      // Closed PR should be ignored.
      { id: 3, repo_id: 1, number: 103, state: "closed", title: "old", author_login: "x", created_at: daysAgoTs(50), merged_at: null, closed_at: daysAgoTs(40), additions: 0, deletions: 0 },
    ]);
    bulkUpsertIssues([
      // Security-labeled (by title), external, open 21 days.
      { id: 11, repo_id: 1, number: 201, state: "open", title: "Security: XSS in login", author_login: "reporter", created_at: daysAgoTs(21), closed_at: null, is_pull_request: 0 },
      // My own normal issue.
      { id: 12, repo_id: 1, number: 202, state: "open", title: "Refactor module", author_login: "octocat", created_at: daysAgoTs(3), closed_at: null, is_pull_request: 0 },
    ]);
  });

  it("flags stale PRs and classifies needs_attention by priority", async () => {
    const res = await call({ stale_days: 14 });

    expect(res.data.counts.open_prs).toBe(2); // closed one excluded
    expect(res.data.counts.open_issues).toBe(2);
    expect(res.data.counts.stale_prs).toBe(1);
    expect(res.data.counts.from_others).toBe(2); // contributor PR + reporter issue

    const stalePr = res.data.open_prs.find((p) => p.number === 101)!;
    expect(stalePr.is_stale).toBe(true);
    expect(res.data.open_prs.find((p) => p.number === 102)!.is_stale).toBe(false);

    // Security issue is inferred from the title.
    const secIssue = res.data.open_issues.find((i) => i.number === 201)!;
    expect(secIssue.labels).toContain("security");

    // needs_attention: security first, then stale PR, then external issue (but
    // the security issue's external status is de-duped under the higher reason).
    const reasons = res.data.needs_attention.map((n) => n.reason);
    expect(res.data.needs_attention[0]!.reason).toBe("labeled security");
    expect(res.data.needs_attention[0]!.number).toBe(201);
    expect(reasons).toContain("PR open 21 days (stale)");
    // My own fresh issue (202) must NOT be flagged.
    expect(res.data.needs_attention.find((n) => n.number === 202)).toBeUndefined();
  });

  it("only_mine filters to the user's items", async () => {
    const res = await call({ only_mine: true });
    expect(res.data.open_prs.map((p) => p.number)).toEqual([102]);
    expect(res.data.open_issues.map((i) => i.number)).toEqual([202]);
    expect(res.data.counts.from_others).toBe(0);
  });
});

describe("fuzzy resolution error path", () => {
  it("errors listing candidates when the repo filter is ambiguous", async () => {
    seedRepo(2, "alpha-svc");
    seedRepo(3, "beta-svc");
    await expect(call({ repo: "svc" })).rejects.toThrow(/matches 2 repos/i);
  });
});
