import { z } from "zod";
import { defineTool } from "./types.js";
import { db } from "../db/client.js";
import { loadConfig } from "../config.js";
import { getContributionCalendar, type ContributionDay } from "../github/graphql.js";
import { ToolError } from "../utils/errors.js";
import {
  addDays,
  dayDiff,
  linreg,
  mondayOf,
  pct,
  repoInClause,
  resolveRepoIds,
  todayInTz,
} from "./_shared.js";

/**
 * MCP tool: contribution summary for a window, optionally compared to the
 * immediately preceding window of equal length, with a weekly trajectory.
 * Contribution totals come from the GraphQL calendar so private work counts.
 */

// Fixed day-lengths per period so the "previous" window is equal in *days*
// (calendar months differ in length; comparing by day count keeps it fair).
const PERIOD_DAYS: Record<string, number> = { week: 7, month: 30, quarter: 90, year: 365 };

// Injection seam so tests can supply a deterministic calendar without network.
type CalendarFetcher = (username: string, from: string, to: string) => Promise<ContributionDay[]>;
let calendarFetcher: CalendarFetcher = (u, f, t) => getContributionCalendar(u, f, t);
/** @internal test hook */
export function __setCalendarFetcher(fn: CalendarFetcher | null): void {
  calendarFetcher = fn ?? ((u, f, t) => getContributionCalendar(u, f, t));
}

const inputSchema = z
  .object({
    period: z.enum(["week", "month", "quarter", "year", "custom"]).default("month"),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    compare_to_previous: z.boolean().default(true),
    repo: z.string().optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

interface Metrics {
  commits: number;
  contributions_total: number;
  prs_opened: number;
  prs_merged: number;
  issues_opened: number;
  issues_closed: number;
  repos_touched: number;
  active_days: number;
  additions: number;
  deletions: number;
  stars_gained: number;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Aggregate SQLite-derived metrics (everything except contributions_total). */
function aggregate(
  startIso: string,
  endIso: string,
  repoIds: number[] | null,
  username: string,
): Omit<Metrics, "contributions_total"> {
  const startTs = `${startIso}T00:00:00Z`;
  const endTs = `${endIso}T23:59:59Z`;
  const { clause, params } = repoInClause(repoIds);

  const c = db
    .prepare(
      `SELECT COUNT(*) AS commits,
              COUNT(DISTINCT committed_date) AS active_days,
              COUNT(DISTINCT repo_id) AS repos_touched,
              COALESCE(SUM(additions),0) AS additions,
              COALESCE(SUM(deletions),0) AS deletions
       FROM commits WHERE committed_date BETWEEN ? AND ?${clause}`,
    )
    .get(startIso, endIso, ...params) as {
    commits: number;
    active_days: number;
    repos_touched: number;
    additions: number;
    deletions: number;
  };

  const prsOpened = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM pull_requests
         WHERE author_login = ? AND created_at BETWEEN ? AND ?${clause}`,
      )
      .get(username, startTs, endTs, ...params) as { n: number }
  ).n;
  const prsMerged = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM pull_requests
         WHERE author_login = ? AND merged_at IS NOT NULL AND merged_at BETWEEN ? AND ?${clause}`,
      )
      .get(username, startTs, endTs, ...params) as { n: number }
  ).n;
  const issuesOpened = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM issues
         WHERE is_pull_request = 0 AND author_login = ? AND created_at BETWEEN ? AND ?${clause}`,
      )
      .get(username, startTs, endTs, ...params) as { n: number }
  ).n;
  const issuesClosed = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM issues
         WHERE is_pull_request = 0 AND author_login = ? AND closed_at IS NOT NULL AND closed_at BETWEEN ? AND ?${clause}`,
      )
      .get(username, startTs, endTs, ...params) as { n: number }
  ).n;
  const starsGained = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM stargazers WHERE starred_at BETWEEN ? AND ?${clause}`)
      .get(startTs, endTs, ...params) as { n: number }
  ).n;

  return {
    commits: c.commits,
    prs_opened: prsOpened,
    prs_merged: prsMerged,
    issues_opened: issuesOpened,
    issues_closed: issuesClosed,
    repos_touched: c.repos_touched,
    active_days: c.active_days,
    additions: c.additions,
    deletions: c.deletions,
    stars_gained: starsGained,
  };
}

function delta(cur: number, prev: number) {
  const abs = cur - prev;
  const percent = prev === 0 ? null : Math.round((abs / prev) * 1000) / 10;
  const direction = abs > 0 ? "up" : abs < 0 ? "down" : "flat";
  return { abs, percent, direction: direction as "up" | "down" | "flat" };
}

export const getContributionSummaryTool = defineTool({
  name: "get_contribution_summary",
  description:
    "Summarize contributions for a period (week/month/quarter/year/custom), optionally compared to " +
    "the previous equal-length window, with a weekly trajectory (least-squares trend). Uses the " +
    "GraphQL contribution calendar so private work is included.",
  inputSchema,
  handler: async (args: Input) => {
    const { GITHUB_USERNAME: username, TIMEZONE: tz } = loadConfig();
    const today = todayInTz(tz);

    // Resolve window.
    let startIso: string;
    let endIso: string;
    let label: string;
    if (args.period === "custom") {
      if (!args.start_date || !args.end_date) {
        throw new ToolError("invalid_input", "period=custom requires both start_date and end_date.");
      }
      startIso = args.start_date.slice(0, 10);
      endIso = args.end_date.slice(0, 10);
      if (!YMD.test(startIso) || !YMD.test(endIso)) {
        throw new ToolError("invalid_input", "start_date/end_date must be YYYY-MM-DD.");
      }
      if (startIso > endIso) throw new ToolError("invalid_input", "start_date must be on or before end_date.");
      label = `${startIso} to ${endIso}`;
    } else {
      const days = PERIOD_DAYS[args.period]!;
      endIso = today;
      startIso = addDays(endIso, -(days - 1));
      label = `This ${args.period}`;
    }
    const days = dayDiff(startIso, endIso) + 1;

    // Previous window: equal length, immediately preceding.
    const prevEnd = addDays(startIso, -1);
    const prevStart = addDays(prevEnd, -(days - 1));

    const repoIds = resolveRepoIds(args.repo);
    const reposCovered = repoIds === null ? null : repoIds.length;

    // Contribution calendar (covers private work). Fetch once over the widest
    // range we need, then slice per window.
    const calStart = args.compare_to_previous ? prevStart : startIso;
    let calendar: ContributionDay[] = [];
    let calendarAvailable = true;
    try {
      calendar = await calendarFetcher(username, calStart, endIso);
    } catch {
      calendarAvailable = false;
    }
    const calByDate = new Map(calendar.map((d) => [d.date, d.count]));
    const sumCal = (from: string, to: string): number => {
      let n = 0;
      for (let d = from; d <= to; d = addDays(d, 1)) n += calByDate.get(d) ?? 0;
      return n;
    };

    // Current metrics.
    const curBase = aggregate(startIso, endIso, repoIds, username);
    const current: Metrics = {
      ...curBase,
      contributions_total: calendarAvailable ? sumCal(startIso, endIso) : curBase.commits,
    };

    // Previous metrics.
    let previous: Metrics | null = null;
    if (args.compare_to_previous) {
      const prevBase = aggregate(prevStart, prevEnd, repoIds, username);
      previous = {
        ...prevBase,
        contributions_total: calendarAvailable ? sumCal(prevStart, prevEnd) : prevBase.commits,
      };
    }

    // Deltas.
    const deltas = previous
      ? (Object.fromEntries(
          (Object.keys(current) as (keyof Metrics)[]).map((k) => [k, delta(current[k], previous![k])]),
        ) as Record<keyof Metrics, ReturnType<typeof delta>>)
      : null;

    // Weekly trend (Monday-anchored) over the current window, gap-filled.
    const commitDayRows = db
      .prepare(
        `SELECT committed_date AS date, COUNT(*) AS n FROM commits
         WHERE committed_date BETWEEN ? AND ?${repoInClause(repoIds).clause}
         GROUP BY committed_date`,
      )
      .all(startIso, endIso, ...repoInClause(repoIds).params) as { date: string; n: number }[];
    const commitByDate = new Map(commitDayRows.map((r) => [r.date, r.n]));

    const weeks: { week_start: string; commits: number; contributions: number }[] = [];
    const firstMonday = mondayOf(startIso);
    const lastMonday = mondayOf(endIso);
    for (let w = firstMonday; w <= lastMonday; w = addDays(w, 7)) {
      let commits = 0;
      let contributions = 0;
      for (let i = 0; i < 7; i++) {
        const d = addDays(w, i);
        if (d < startIso || d > endIso) continue;
        commits += commitByDate.get(d) ?? 0;
        contributions += calendarAvailable ? calByDate.get(d) ?? 0 : commitByDate.get(d) ?? 0;
      }
      weeks.push({ week_start: w, commits, contributions });
    }

    // Trajectory: least-squares over weekly commits.
    const reg = linreg(weeks.map((w) => w.commits));
    const points = weeks.length;
    const lowConfidence = points < 6 || reg.r2 < 0.3;
    const confidence: "high" | "medium" | "low" = lowConfidence
      ? "low"
      : points >= 12 && reg.r2 >= 0.6
        ? "high"
        : "medium";
    const direction = reg.slope > 0.05 ? "rising" : reg.slope < -0.05 ? "falling" : "flat";
    const trajectory = {
      slope_commits_per_week: Math.round(reg.slope * 100) / 100,
      direction,
      r_squared: Math.round(reg.r2 * 100) / 100,
      confidence,
    };

    // Most active repo.
    const topRepoRow = db
      .prepare(
        `SELECT COALESCE(r.full_name, r.name, 'unknown') AS name, COUNT(*) AS commits
         FROM commits c LEFT JOIN repos r ON r.id = c.repo_id
         WHERE c.committed_date BETWEEN ? AND ?${repoInClause(repoIds, "c.repo_id").clause}
         GROUP BY c.repo_id ORDER BY commits DESC LIMIT 1`,
      )
      .get(startIso, endIso, ...repoInClause(repoIds, "c.repo_id").params) as
      | { name: string; commits: number }
      | undefined;

    const consistency = days > 0 ? Math.round((current.active_days / days) * 100) / 100 : 0;

    // Summary.
    const cmpStr =
      deltas && deltas.commits.percent !== null ? ` (${deltas.commits.percent >= 0 ? "+" : ""}${deltas.commits.percent}% vs previous ${args.period === "custom" ? "window" : args.period})` : "";
    const trendStr = `Trend over ${points} weeks: ${direction} (${trajectory.slope_commits_per_week >= 0 ? "+" : ""}${trajectory.slope_commits_per_week} commits/week, ${confidence} confidence).`;
    const summary =
      `${label}: ${current.commits} commits${cmpStr}, ${current.prs_opened} PRs opened, ${current.prs_merged} merged, ` +
      `${current.repos_touched} repos touched, ${current.active_days}/${days} active days. ${trendStr}`;

    return {
      summary,
      data: {
        period: { label, start: startIso, end: endIso, days },
        current,
        previous,
        deltas,
        weekly_trend: weeks,
        trajectory,
        most_active_repo: topRepoRow ? { name: topRepoRow.name, commits: topRepoRow.commits } : null,
        consistency_score: consistency,
      },
      meta: {
        from_cache: true,
        stale: false,
        generated_at: new Date().toISOString(),
        period: { start: startIso, end: endIso, days },
        repos_covered: reposCovered,
        ...(calendarAvailable ? {} : { note: "Contribution calendar unavailable; contributions_total falls back to commit counts." }),
      },
    };
  },
});
