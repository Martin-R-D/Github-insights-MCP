import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DB_PATH = ":memory:";
process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_USERNAME = "octocat";
process.env.TIMEZONE = "UTC";

type ToolMod = typeof import("./compare_repos.js");
let tool: ToolMod["compareReposTool"];
let upsertRepo: typeof import("../db/repos.js").upsertRepo;
let bulkUpsertCommits: typeof import("../db/commits.js").bulkUpsertCommits;
let bulkUpsertStargazers: typeof import("../db/stars.js").bulkUpsertStargazers;
let db: typeof import("../db/client.js").db;

const DAY_MS = 86_400_000;
const TODAY = new Date().toISOString().slice(0, 10);
function daysAgo(n: number) {
  return new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);
}
function daysAgoTs(n: number) {
  return new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * DAY_MS).toISOString();
}

function seedRepo(id: number, name: string, stars: number, created_at: string) {
  upsertRepo({
    id, name, full_name: `octocat/${name}`, owner: "octocat", private: 0, fork: 0,
    description: null, stars, forks: 3, watchers: 0, open_issues: 0, primary_language: "TypeScript",
    size_kb: 100, default_branch: "main", created_at, pushed_at: null, updated_at: null,
    archived: 0, synced_at: new Date().toISOString(),
  });
}
let sha = 0;
function commit(repoId: number, date: string) {
  return {
    sha: `s${sha++}`, repo_id: repoId, author_login: "octocat", author_email: "o@e.com",
    committed_at: `${date}T12:00:00Z`, committed_date: date, hour: 12, dow: 3,
    additions: 1, deletions: 0, files_changed: 1, message: "w",
  };
}

async function call(args: Record<string, unknown>) {
  const parsed = tool.inputSchema.parse(args);
  return (await tool.handler(parsed)) as {
    data: {
      repos: { name: string; stars: number; commits_in_period: number; commits_per_month: number }[];
      winners: { most_stars: { repo: string }; most_active: { repo: string } };
      head_to_head: { metric: string; leader: string; margin_percent: number | null }[];
      verdict: string;
    };
  };
}

beforeAll(async () => {
  tool = (await import("./compare_repos.js")).compareReposTool;
  upsertRepo = (await import("../db/repos.js")).upsertRepo;
  bulkUpsertCommits = (await import("../db/commits.js")).bulkUpsertCommits;
  bulkUpsertStargazers = (await import("../db/stars.js")).bulkUpsertStargazers;
  db = (await import("../db/client.js")).db;
});

beforeEach(() => {
  db.exec("DELETE FROM repos; DELETE FROM commits; DELETE FROM stargazers;");
});

describe("comparison", () => {
  it("picks winners and normalizes per-month rates for age", async () => {
    // keystrike: old & big. musicflow: young & active.
    seedRepo(1, "keystrike", 214, daysAgo(1460)); // ~4 years
    seedRepo(2, "musicflow", 89, daysAgo(60)); // 2 months
    // keystrike more total commits, musicflow more recent commits.
    bulkUpsertCommits([...Array(6)].map((_, i) => commit(1, daysAgo(300 + i))));
    bulkUpsertCommits([commit(1, daysAgo(2))]);
    bulkUpsertCommits([...Array(5)].map((_, i) => commit(2, daysAgo(3 + i))));
    bulkUpsertStargazers([{ repo_id: 2, user_login: "u", starred_at: daysAgoTs(5) }]);

    const res = await call({ repos: ["keystrike", "musicflow"], days: 90 });
    expect(res.data.winners.most_stars.repo).toBe("octocat/keystrike");
    expect(res.data.winners.most_active.repo).toBe("octocat/musicflow"); // 5 vs 1 in 90d

    const music = res.data.repos.find((r) => r.name === "octocat/musicflow")!;
    const key = res.data.repos.find((r) => r.name === "octocat/keystrike")!;
    // Fairness: musicflow's commits/month should beat keystrike's despite fewer total.
    expect(music.commits_per_month).toBeGreaterThan(key.commits_per_month);
    expect(res.data.verdict).toMatch(/bigger project.*live one/);

    const starsH2H = res.data.head_to_head.find((h) => h.metric === "stars")!;
    expect(starsH2H.leader).toBe("octocat/keystrike");
  });
});

describe("fuzzy resolution error path", () => {
  it("errors listing candidates when a repo name is ambiguous", async () => {
    seedRepo(1, "alpha-api", 1, daysAgo(100));
    seedRepo(2, "beta-api", 2, daysAgo(100));
    await expect(call({ repos: ["api", "alpha-api"] })).rejects.toThrow(/matches 2 repos/i);
  });
});
