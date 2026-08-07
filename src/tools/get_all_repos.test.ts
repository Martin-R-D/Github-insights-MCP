import { beforeAll, beforeEach, describe, expect, it } from "vitest";

// Isolated in-memory DB before the db singleton is imported.
process.env.DB_PATH = ":memory:";
process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_USERNAME = "octocat";

type ToolMod = typeof import("./get_all_repos.js");
type ReposMod = typeof import("../db/repos.js");
type ClientMod = typeof import("../db/client.js");

let getAllReposTool: ToolMod["getAllReposTool"];
let upsertRepo: ReposMod["upsertRepo"];
let db: ClientMod["db"];

const NOW = new Date().toISOString();

interface SeedOverrides {
  id: number;
  name: string;
  fork?: number;
  archived?: number;
  private?: number;
  stars?: number;
  size_kb?: number;
  pushed_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

function seed(o: SeedOverrides) {
  upsertRepo({
    id: o.id,
    name: o.name,
    full_name: `octocat/${o.name}`,
    owner: "octocat",
    private: o.private ?? 0,
    fork: o.fork ?? 0,
    description: null,
    stars: o.stars ?? 0,
    forks: 1,
    watchers: 0,
    open_issues: 2,
    primary_language: "TypeScript",
    size_kb: o.size_kb ?? 100,
    default_branch: "main",
    created_at: o.created_at ?? "2024-01-01T00:00:00Z",
    pushed_at: o.pushed_at ?? "2024-06-01T00:00:00Z",
    updated_at: o.updated_at ?? "2024-06-01T00:00:00Z",
    archived: o.archived ?? 0,
    // Fresh synced_at keeps the tool from calling syncRepos() (no network).
    synced_at: NOW,
  });
}

async function call(args: Record<string, unknown>) {
  const parsed = getAllReposTool.inputSchema.parse(args);
  return (await getAllReposTool.handler(parsed)) as {
    summary: string;
    data: {
      total_repos: number;
      total_stars: number;
      repos: { name: string; fork: boolean; archived: boolean; private: boolean }[];
    };
    meta: { from_cache: boolean; repos_covered: number };
  };
}

beforeAll(async () => {
  getAllReposTool = (await import("./get_all_repos.js")).getAllReposTool;
  upsertRepo = (await import("../db/repos.js")).upsertRepo;
  db = (await import("../db/client.js")).db;
});

beforeEach(() => {
  db.exec("DELETE FROM repos;");
});

describe("get_all_repos filters", () => {
  beforeEach(() => {
    seed({ id: 1, name: "source", fork: 0, archived: 0, private: 0 });
    seed({ id: 2, name: "forked", fork: 1 });
    seed({ id: 3, name: "old", archived: 1 });
    seed({ id: 4, name: "secret", private: 1 });
  });

  it("excludes forks and archived by default, keeps private", async () => {
    const res = await call({});
    const names = res.data.repos.map((r) => r.name).sort();
    expect(names).toEqual(["secret", "source"]);
    expect(res.data.total_repos).toBe(2);
    expect(res.meta.from_cache).toBe(true); // fresh cache → no sync
  });

  it("includes forks when include_forks=true", async () => {
    const res = await call({ include_forks: true });
    expect(res.data.repos.map((r) => r.name)).toContain("forked");
  });

  it("includes archived when include_archived=true", async () => {
    const res = await call({ include_archived: true });
    expect(res.data.repos.map((r) => r.name)).toContain("old");
  });

  it("excludes private when include_private=false", async () => {
    const res = await call({ include_private: false });
    expect(res.data.repos.map((r) => r.name)).not.toContain("secret");
  });
});

describe("get_all_repos sorting", () => {
  beforeEach(() => {
    seed({ id: 1, name: "bravo", stars: 5, size_kb: 300, created_at: "2024-03-01T00:00:00Z" });
    seed({ id: 2, name: "alpha", stars: 50, size_kb: 100, created_at: "2024-01-01T00:00:00Z" });
    seed({ id: 3, name: "charlie", stars: 20, size_kb: 200, created_at: "2024-05-01T00:00:00Z" });
  });

  it("sorts by stars descending", async () => {
    const res = await call({ sort: "stars" });
    expect(res.data.repos.map((r) => r.name)).toEqual(["alpha", "charlie", "bravo"]);
  });

  it("sorts by size descending", async () => {
    const res = await call({ sort: "size" });
    expect(res.data.repos.map((r) => r.name)).toEqual(["bravo", "charlie", "alpha"]);
  });

  it("sorts by name ascending", async () => {
    const res = await call({ sort: "name" });
    expect(res.data.repos.map((r) => r.name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("sorts by created descending", async () => {
    const res = await call({ sort: "created" });
    expect(res.data.repos.map((r) => r.name)).toEqual(["charlie", "bravo", "alpha"]);
  });
});

describe("get_all_repos limit", () => {
  beforeEach(() => {
    for (let i = 1; i <= 10; i++) seed({ id: i, name: `repo-${i}`, stars: i });
  });

  it("caps the number of returned repos but totals cover all", async () => {
    const res = await call({ limit: 3, sort: "stars" });
    expect(res.data.repos).toHaveLength(3);
    expect(res.data.total_repos).toBe(10); // totals ignore the limit
    expect(res.meta.repos_covered).toBe(10);
    expect(res.data.repos.map((r) => r.name)).toEqual(["repo-10", "repo-9", "repo-8"]);
  });
});
