import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DB_PATH = ":memory:";
process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_USERNAME = "octocat";
process.env.TIMEZONE = "UTC";

type ToolMod = typeof import("./get_language_breakdown.js");
let tool: ToolMod["getLanguageBreakdownTool"];
let upsertRepo: typeof import("../db/repos.js").upsertRepo;
let bulkUpsertLanguages: typeof import("../db/languages.js").bulkUpsertLanguages;
let db: typeof import("../db/client.js").db;

const NOW = new Date().toISOString();

function seedRepo(id: number, name: string, stars: number) {
  upsertRepo({
    id, name, full_name: `octocat/${name}`, owner: "octocat", private: 0, fork: 0,
    description: null, stars, forks: 0, watchers: 0, open_issues: 0, primary_language: null,
    size_kb: 0, default_branch: "main", created_at: null, pushed_at: null, updated_at: null,
    archived: 0, synced_at: NOW,
  });
}

async function call(args: Record<string, unknown> = {}) {
  const parsed = tool.inputSchema.parse(args);
  return (await tool.handler(parsed)) as {
    data: {
      total_bytes: number;
      repos_analyzed: number;
      distinct_languages: number;
      primary_language: string | null;
      polyglot_score: number;
      languages: { language: string; percent: number; repo_count: number; stars_in_language: number; estimated_lines?: number }[];
    };
    meta: { note?: string };
  };
}

beforeAll(async () => {
  tool = (await import("./get_language_breakdown.js")).getLanguageBreakdownTool;
  upsertRepo = (await import("../db/repos.js")).upsertRepo;
  bulkUpsertLanguages = (await import("../db/languages.js")).bulkUpsertLanguages;
  db = (await import("../db/client.js")).db;
});

beforeEach(() => {
  db.exec("DELETE FROM repos; DELETE FROM repo_languages; DELETE FROM sync_state;");
});

describe("rollup", () => {
  beforeEach(() => {
    seedRepo(1, "one", 10);
    seedRepo(2, "two", 5);
    // Fresh synced_at => no network sync.
    bulkUpsertLanguages(1, { TypeScript: 800, CSS: 200 }, NOW);
    bulkUpsertLanguages(2, { TypeScript: 400, Python: 600 }, NOW);
  });

  it("weights by bytes and reports repo_count and stars_in_language", async () => {
    const res = await call({ weight_by: "bytes" });
    expect(res.data.total_bytes).toBe(2000);
    expect(res.data.repos_analyzed).toBe(2);
    expect(res.data.distinct_languages).toBe(3);
    expect(res.data.primary_language).toBe("TypeScript");

    const ts = res.data.languages.find((l) => l.language === "TypeScript")!;
    expect(ts.percent).toBe(60); // 1200 / 2000
    expect(ts.repo_count).toBe(2);
    expect(ts.stars_in_language).toBe(15); // 10 + 5
    expect(res.data.polyglot_score).toBeGreaterThan(0);
    expect(res.data.polyglot_score).toBeLessThanOrEqual(1);
  });

  it("weights by repo count", async () => {
    const res = await call({ weight_by: "repos" });
    const ts = res.data.languages.find((l) => l.language === "TypeScript")!;
    const py = res.data.languages.find((l) => l.language === "Python")!;
    expect(ts.percent).toBe(50); // 2 of 4 repo-language pairs
    expect(py.percent).toBe(25);
  });

  it("adds estimated_lines with a note when estimate_lines=true", async () => {
    const res = await call({ estimate_lines: true });
    const ts = res.data.languages.find((l) => l.language === "TypeScript")!;
    expect(typeof ts.estimated_lines).toBe("number");
    expect(res.meta.note).toMatch(/estimate/i);
  });
});

describe("empty data", () => {
  it("returns zeros without NaN when there is no language data", async () => {
    const res = await call({});
    expect(res.data.total_bytes).toBe(0);
    expect(res.data.repos_analyzed).toBe(0);
    expect(res.data.distinct_languages).toBe(0);
    expect(res.data.primary_language).toBeNull();
    expect(Number.isNaN(res.data.polyglot_score)).toBe(false);
    expect(res.data.polyglot_score).toBe(0);
  });
});
