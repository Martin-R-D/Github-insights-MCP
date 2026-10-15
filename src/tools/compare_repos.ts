import { z } from "zod";
import { defineTool } from "./types.js";
import { db } from "../db/client.js";
import { loadConfig } from "../config.js";
import { addDays, DAY_MS, resolveRepoRow, todayInTz } from "./_shared.js";
import type { RepoRow } from "../db/types.js";

/**
 * MCP tool: compare 2–5 repos side by side over a period, with fairness-adjusted
 * per-month rates so a young repo isn't unfairly measured against an old one.
 */

const inputSchema = z
  .object({
    repos: z.array(z.string().min(1)).min(2).max(5),
    days: z.number().int().min(1).max(1095).default(90),
    metrics: z.array(z.string()).optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

interface RepoMetrics {
  name: string;
  stars: number;
  stars_gained: number;
  forks: number;
  commits_in_period: number;
  commits_all_time: number;
  active_days: number;
  last_commit_days_ago: number | null;
  open_issues: number;
  open_prs: number;
  merged_prs_in_period: number;
  primary_language: string | null;
  age_days: number | null;
  contributors: number;
  size_kb: number;
  commits_per_month_lifetime: number;
  stars_per_month_since_creation: number;
}

function computeMetrics(repo: RepoRow, startIso: string, endIso: string, nowMs: number): RepoMetrics {
  const id = repo.id;
  const startTs = `${startIso}T00:00:00Z`;
  const endTs = `${endIso}T23:59:59Z`;

  const c = db
    .prepare(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT committed_date) AS active
       FROM commits WHERE repo_id = ? AND committed_date BETWEEN ? AND ?`,
    )
    .get(id, startIso, endIso) as { n: number; active: number };
  const allTime = (db.prepare("SELECT COUNT(*) AS n FROM commits WHERE repo_id = ?").get(id) as { n: number }).n;
  const contributors = (
    db.prepare("SELECT COUNT(DISTINCT author_login) AS n FROM commits WHERE repo_id = ? AND author_login IS NOT NULL").get(id) as {
      n: number;
    }
  ).n;
  const lastCommit = (
    db.prepare("SELECT MAX(committed_at) AS last FROM commits WHERE repo_id = ?").get(id) as { last: string | null }
  ).last;
  const starsGained = (
    db.prepare("SELECT COUNT(*) AS n FROM stargazers WHERE repo_id = ? AND starred_at >= ?").get(id, startTs) as {
      n: number;
    }
  ).n;
  const openIssues = (
    db.prepare("SELECT COUNT(*) AS n FROM issues WHERE repo_id = ? AND is_pull_request = 0 AND state = 'open'").get(id) as {
      n: number;
    }
  ).n;
  const openPrs = (
    db.prepare("SELECT COUNT(*) AS n FROM pull_requests WHERE repo_id = ? AND state = 'open'").get(id) as { n: number }
  ).n;
  const mergedPrs = (
    db
      .prepare("SELECT COUNT(*) AS n FROM pull_requests WHERE repo_id = ? AND merged_at IS NOT NULL AND merged_at BETWEEN ? AND ?")
      .get(id, startTs, endTs) as { n: number }
  ).n;

  const ageDays = repo.created_at ? Math.max(0, Math.floor((nowMs - Date.parse(repo.created_at)) / DAY_MS)) : null;
  const ageMonths = Math.max(1, (ageDays ?? 30) / 30.44); // guard: never divide by <1 month
  const lastCommitDaysAgo = lastCommit ? Math.floor((nowMs - Date.parse(lastCommit)) / DAY_MS) : null;

  return {
    name: repo.full_name ?? repo.name ?? String(id),
    stars: repo.stars ?? 0,
    stars_gained: starsGained,
    forks: repo.forks ?? 0,
    commits_in_period: c.n,
    commits_all_time: allTime,
    active_days: c.active,
    last_commit_days_ago: lastCommitDaysAgo,
    open_issues: openIssues,
    open_prs: openPrs,
    merged_prs_in_period: mergedPrs,
    primary_language: repo.primary_language,
    age_days: ageDays,
    contributors,
    size_kb: repo.size_kb ?? 0,
    commits_per_month_lifetime: Math.round((allTime / ageMonths) * 10) / 10,
    stars_per_month_since_creation: Math.round(((repo.stars ?? 0) / ageMonths) * 10) / 10,
  };
}

// Metric definitions for head-to-head. `high` means bigger is better.
const METRICS: { key: keyof RepoMetrics; direction: "high" | "low" }[] = [
  { key: "stars", direction: "high" },
  { key: "stars_gained", direction: "high" },
  { key: "forks", direction: "high" },
  { key: "commits_in_period", direction: "high" },
  { key: "commits_all_time", direction: "high" },
  { key: "active_days", direction: "high" },
  { key: "merged_prs_in_period", direction: "high" },
  { key: "contributors", direction: "high" },
  { key: "commits_per_month_lifetime", direction: "high" },
  { key: "stars_per_month_since_creation", direction: "high" },
  { key: "last_commit_days_ago", direction: "low" },
];

function argBest(rows: RepoMetrics[], key: keyof RepoMetrics, direction: "high" | "low"): RepoMetrics {
  return rows.reduce((best, r) => {
    const rv = (r[key] as number | null) ?? (direction === "high" ? -Infinity : Infinity);
    const bv = (best[key] as number | null) ?? (direction === "high" ? -Infinity : Infinity);
    if (direction === "high") return rv > bv ? r : best;
    return rv < bv ? r : best;
  }, rows[0]!);
}

export const compareReposTool = defineTool({
  name: "compare_repos",
  description:
    "Compare 2–5 repos over a period: stars, commits, activity, PRs/issues, plus fairness-normalized " +
    "per-month rates (so a 4-year-old repo isn't unfairly compared to a 2-month-old one).",
  inputSchema,
  handler: (args: Input) => {
    const { TIMEZONE: tz } = loadConfig();
    const endIso = todayInTz(tz);
    const startIso = addDays(endIso, -(args.days - 1));
    const nowMs = Date.now();

    // Resolve each repo (throws a candidate-listing error on ambiguity).
    const rows = args.repos.map((r) => computeMetrics(resolveRepoRow(r), startIso, endIso, nowMs));

    const winners = {
      most_stars: pickWinner(rows, "stars", "high"),
      most_commits: pickWinner(rows, "commits_all_time", "high"),
      most_active: pickWinner(rows, "commits_in_period", "high"),
      fastest_growing: pickWinner(rows, "stars_gained", "high"),
      most_recently_touched: pickWinner(rows, "last_commit_days_ago", "low"),
    };

    const selected = args.metrics && args.metrics.length > 0
      ? METRICS.filter((m) => args.metrics!.includes(m.key))
      : METRICS;

    const headToHead = selected.map(({ key, direction }) => {
      const values = Object.fromEntries(rows.map((r) => [r.name, r[key]]));
      const sorted = [...rows].sort((a, b) => {
        const av = (a[key] as number | null) ?? (direction === "high" ? -Infinity : Infinity);
        const bv = (b[key] as number | null) ?? (direction === "high" ? -Infinity : Infinity);
        return direction === "high" ? bv - av : av - bv;
      });
      const best = sorted[0]!;
      const runnerUp = sorted[1]!;
      const bestVal = (best[key] as number | null) ?? 0;
      const runnerVal = (runnerUp[key] as number | null) ?? 0;
      const base = Math.abs(runnerVal);
      const margin = base > 0 ? Math.round((Math.abs(bestVal - runnerVal) / base) * 1000) / 10 : null;
      return { metric: key, values, leader: best.name, margin_percent: margin };
    });

    const verdict =
      winners.most_stars.repo !== winners.most_active.repo
        ? `${short(winners.most_stars.repo)} is the bigger project, ${short(winners.most_active.repo)} is the live one.`
        : `${short(winners.most_stars.repo)} leads across the board.`;

    const topStars = [...rows].sort((a, b) => b.stars - a.stars);
    const topActive = [...rows].sort((a, b) => b.commits_in_period - a.commits_in_period);
    const summary =
      `${short(topStars[0]!.name)} leads on stars (${topStars[0]!.stars} vs ${topStars[1]!.stars}), ` +
      `${short(topActive[0]!.name)} is most active (${topActive[0]!.commits_in_period} commits in ${args.days}d ` +
      `vs ${topActive[1]!.commits_in_period}). Verdict: ${verdict}`;

    return {
      summary,
      data: {
        period: { start: startIso, end: endIso, days: args.days },
        repos: rows,
        winners,
        head_to_head: headToHead,
        verdict,
      },
      meta: {
        from_cache: true,
        stale: false,
        generated_at: new Date().toISOString(),
        period: { start: startIso, end: endIso, days: args.days },
        repos_covered: rows.length,
      },
    };
  },
});

function pickWinner(rows: RepoMetrics[], key: keyof RepoMetrics, direction: "high" | "low") {
  const w = argBest(rows, key, direction);
  return { repo: w.name, value: w[key] };
}

function short(fullName: string): string {
  const slash = fullName.indexOf("/");
  return slash >= 0 ? fullName.slice(slash + 1) : fullName;
}
