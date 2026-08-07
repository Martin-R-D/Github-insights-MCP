import { beforeAll, beforeEach, describe, expect, it } from "vitest";

// Force an isolated in-memory database BEFORE the client singleton is imported.
process.env.DB_PATH = ":memory:";

type ReposMod = typeof import("./repos.js");
type CommitsMod = typeof import("./commits.js");
type ClientMod = typeof import("./client.js");

let repos: ReposMod;
let commits: CommitsMod;
let client: ClientMod;

beforeAll(async () => {
  client = await import("./client.js");
  repos = await import("./repos.js");
  commits = await import("./commits.js");
});

beforeEach(() => {
  // Clean slate between cases (same in-memory connection for the file).
  client.db.exec("DELETE FROM repos; DELETE FROM commits;");
});

function makeRepo(overrides: Partial<ReturnType<typeof baseRepo>> = {}) {
  return { ...baseRepo(), ...overrides };
}

function baseRepo() {
  return {
    id: 1,
    name: "insights",
    full_name: "octocat/insights",
    owner: "octocat",
    private: 0,
    fork: 0,
    description: "demo",
    stars: 10,
    forks: 2,
    watchers: 10,
    open_issues: 1,
    primary_language: "TypeScript",
    size_kb: 100,
    default_branch: "main",
    created_at: "2024-01-01T00:00:00Z",
    pushed_at: "2024-06-01T00:00:00Z",
    updated_at: "2024-06-01T00:00:00Z",
    archived: 0,
    synced_at: null as string | null,
  };
}

describe("repos upsert idempotency", () => {
  it("does not duplicate rows on repeated upsert of the same id", () => {
    repos.upsertRepo(makeRepo());
    repos.upsertRepo(makeRepo({ stars: 20, description: "updated" }));

    const all = repos.listRepos();
    expect(all).toHaveLength(1);
    expect(all[0]?.stars).toBe(20);
    expect(all[0]?.description).toBe("updated");
  });

  it("getRepo resolves by full_name and by bare name", () => {
    repos.upsertRepo(makeRepo());
    expect(repos.getRepo("octocat/insights")?.id).toBe(1);
    expect(repos.getRepo("insights")?.id).toBe(1);
    expect(repos.getRepo(1)?.full_name).toBe("octocat/insights");
    expect(repos.getRepo("nope")).toBeUndefined();
  });

  it("updateRepoStats changes only stat columns", () => {
    repos.upsertRepo(makeRepo());
    repos.updateRepoStats({
      id: 1,
      stars: 99,
      forks: 9,
      watchers: 99,
      open_issues: 3,
    });
    const r = repos.getRepo(1);
    expect(r?.stars).toBe(99);
    expect(r?.open_issues).toBe(3);
    expect(r?.description).toBe("demo"); // untouched
  });
});

describe("listRepos filters", () => {
  beforeEach(() => {
    repos.upsertRepo(makeRepo({ id: 1, full_name: "o/plain", fork: 0, archived: 0, private: 0 }));
    repos.upsertRepo(makeRepo({ id: 2, full_name: "o/forked", fork: 1, archived: 0, private: 0 }));
    repos.upsertRepo(makeRepo({ id: 3, full_name: "o/archived", fork: 0, archived: 1, private: 0 }));
    repos.upsertRepo(makeRepo({ id: 4, full_name: "o/private", fork: 0, archived: 0, private: 1 }));
  });

  it("includes everything by default", () => {
    expect(repos.listRepos()).toHaveLength(4);
  });

  it("excludes forks when includeForks=false", () => {
    const ids = repos.listRepos({ includeForks: false }).map((r) => r.id);
    expect(ids).not.toContain(2);
    expect(ids).toHaveLength(3);
  });

  it("excludes archived when includeArchived=false", () => {
    const ids = repos.listRepos({ includeArchived: false }).map((r) => r.id);
    expect(ids).not.toContain(3);
  });

  it("excludes private when includePrivate=false", () => {
    const ids = repos.listRepos({ includePrivate: false }).map((r) => r.id);
    expect(ids).not.toContain(4);
  });

  it("combines filters", () => {
    const ids = repos
      .listRepos({ includeForks: false, includeArchived: false, includePrivate: false })
      .map((r) => r.id);
    expect(ids).toEqual([1]);
  });
});

describe("commits bulk upsert idempotency", () => {
  function makeCommit(sha: string, date: string) {
    return {
      sha,
      repo_id: 1,
      author_login: "octocat",
      author_email: "o@example.com",
      committed_at: `${date}T12:00:00Z`,
      committed_date: date,
      hour: 12,
      dow: 3,
      additions: 5,
      deletions: 1,
      files_changed: 2,
      message: "work",
    };
  }

  it("re-upserting the same shas does not duplicate", () => {
    const batch = [makeCommit("aaa", "2024-05-01"), makeCommit("bbb", "2024-05-02")];
    commits.bulkUpsertCommits(batch);
    commits.bulkUpsertCommits(batch); // repeat sync

    const range = { from: "2024-01-01", to: "2024-12-31" };
    expect(commits.countCommits(range)).toBe(2);
    expect(commits.getDistinctCommitDates(range)).toEqual(["2024-05-01", "2024-05-02"]);
    expect(commits.listCommits(1, range)).toHaveLength(2);
  });

  it("respects the date range boundaries", () => {
    commits.bulkUpsertCommits([
      makeCommit("in1", "2024-05-10"),
      makeCommit("out1", "2024-07-10"),
    ]);
    expect(commits.countCommits({ from: "2024-05-01", to: "2024-05-31" })).toBe(1);
  });
});
