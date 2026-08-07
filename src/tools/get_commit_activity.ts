import { z } from "zod";
import { formatInTimeZone } from "date-fns-tz";

import { defineTool } from "./types.js";
import { db } from "../db/client.js";
import { getRepo, listRepos } from "../db/repos.js";
import { getSyncState } from "../db/sync_state.js";
import { syncRepoCommits, syncRepos } from "../services/sync.js";
import { loadConfig } from "../config.js";
import { ToolError } from "../utils/errors.js";

/**
 * MCP tool: aggregate commit activity over a time window. Ensures the window is
 * synced (incremental) then aggregates in SQL, filling zero-commit buckets so
 * the timeline has no gaps.
 */

const DAY_MS = 86_400_000;
const SYNC_STALE_MS = 5 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const YMD = /^\d{4}-\d{2}-\d{2}$/;

const inputSchema = z
  .object({
    repo: z.string().optional(),
    days: z.number().int().min(1).max(730).default(30),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    granularity: z.enum(["day", "week", "month"]).default("day"),
    include_bots: z.boolean().default(false),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;
type Granularity = Input["granularity"];

// --- calendar helpers (dates are plain YYYY-MM-DD, treated as UTC midnight) ---

function toUTC(d: string): number {
  const [y, m, day] = d.split("-").map(Number);
  return Date.UTC(y!, m! - 1, day!);
}
function fromUTC(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function addDays(d: string, n: number): string {
  return fromUTC(toUTC(d) + n * DAY_MS);
}
function mondayOf(d: string): string {
  const dow = new Date(toUTC(d)).getUTCDay(); // 0=Sun..6=Sat
  const diff = (dow + 6) % 7; // days since Monday
  return fromUTC(toUTC(d) - diff * DAY_MS);
}
function firstOfMonth(d: string): string {
  return d.slice(0, 7) + "-01";
}
function addMonths(d: string, n: number): string {
  const [y, m] = d.split("-").map(Number);
  const total = y! * 12 + (m! - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

function bucketOf(date: string, g: Granularity): string {
  if (g === "week") return mondayOf(date);
  if (g === "month") return firstOfMonth(date);
  return date;
}

/** Ordered list of every bucket label between start and end (inclusive). */
function bucketSequence(startIso: string, endIso: string, g: Granularity): string[] {
  const out: string[] = [];
  if (g === "day") {
    for (let d = startIso; d <= endIso; d = addDays(d, 1)) out.push(d);
  } else if (g === "week") {
    const last = mondayOf(endIso);
    for (let d = mondayOf(startIso); d <= last; d = addDays(d, 7)) out.push(d);
  } else {
    const last = firstOfMonth(endIso);
    for (let d = firstOfMonth(startIso); d <= last; d = addMonths(d, 1)) out.push(d);
  }
  return out;
}

interface DayRow {
  date: string;
  commits: number;
  additions: number;
  deletions: number;
}

interface RepoRow {
  repo: string;
  commits: number;
}

/** Build the shared WHERE clause + params for the aggregation queries. */
function buildFilter(repoIds: number[] | null, includeBots: boolean, startIso: string, endIso: string) {
  const params: (string | number)[] = [startIso, endIso];
  let clause = "committed_date BETWEEN ? AND ?";

  if (repoIds !== null) {
    if (repoIds.length === 0) {
      clause += " AND 1 = 0"; // requested repo not found → no rows
    } else {
      clause += ` AND repo_id IN (${repoIds.map(() => "?").join(",")})`;
      params.push(...repoIds);
    }
  }
  if (!includeBots) {
    // GitHub bot logins end with "[bot]". '[' is a literal in SQL LIKE.
    clause += " AND (author_login IS NULL OR author_login NOT LIKE '%[bot]')";
  }
  return { clause, params };
}

function fmtDay(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${MONTHS[m! - 1]} ${d}`;
}

export const getCommitActivityTool = defineTool({
  name: "get_commit_activity",
  description:
    "Aggregate commit activity over a window (default last 30 days) by day/week/month, " +
    "with a gap-filled timeline, per-repo breakdown, busiest day and longest quiet stretch. " +
    "Syncs the window first if the local cache is stale.",
  inputSchema,
  handler: async (args: Input) => {
    const { TIMEZONE: tz } = loadConfig();

    // 1. Resolve the window.
    let startIso: string;
    let endIso: string;
    let daysRequested: number | undefined;
    if (args.start_date && args.end_date) {
      startIso = args.start_date.slice(0, 10);
      endIso = args.end_date.slice(0, 10);
      if (!YMD.test(startIso) || !YMD.test(endIso)) {
        throw new ToolError("invalid_input", "start_date and end_date must be ISO dates (YYYY-MM-DD).");
      }
    } else {
      daysRequested = args.days;
      endIso = formatInTimeZone(new Date(), tz, "yyyy-MM-dd");
      startIso = addDays(endIso, -(daysRequested - 1));
    }
    if (startIso > endIso) {
      throw new ToolError("invalid_input", "start_date must be on or before end_date.");
    }

    // 2. Determine the repo set.
    let repoIds: number[] | null; // null = all repos
    if (args.repo) {
      const row = getRepo(args.repo);
      repoIds = row ? [row.id] : [];
    } else {
      let all = listRepos({ includeForks: true, includeArchived: true, includePrivate: true });
      if (all.length === 0) {
        await syncRepos();
        all = listRepos({ includeForks: true, includeArchived: true, includePrivate: true });
      }
      repoIds = all.map((r) => r.id);
    }

    // 3. Ensure the window is synced. Sync a repo whose commits state is stale
    //    (> 5 min) or predates the window start.
    let syncedAny = false;
    for (const id of repoIds) {
      const st = getSyncState(`commits:${id}`);
      const last = st?.last_synced_at ?? null;
      const stale =
        !last || Date.now() - Date.parse(last) > SYNC_STALE_MS || last < startIso;
      if (stale) {
        await syncRepoCommits(id, { since: startIso });
        syncedAny = true;
      }
    }

    // 4. Aggregate in SQL at day grain (bounded rows), plus a per-repo rollup.
    const { clause, params } = buildFilter(repoIds, args.include_bots, startIso, endIso);

    const dayRows = db
      .prepare(
        `SELECT committed_date AS date,
                COUNT(*)                 AS commits,
                COALESCE(SUM(additions),0) AS additions,
                COALESCE(SUM(deletions),0) AS deletions
         FROM commits
         WHERE ${clause}
         GROUP BY committed_date
         ORDER BY committed_date`,
      )
      .all(...params) as DayRow[];

    const repoRows = db
      .prepare(
        `SELECT COALESCE(r.full_name, r.name, 'unknown') AS repo,
                COUNT(*) AS commits
         FROM commits c
         LEFT JOIN repos r ON r.id = c.repo_id
         WHERE ${clause}
         GROUP BY c.repo_id
         ORDER BY commits DESC`,
      )
      .all(...params) as RepoRow[];

    // 5. Totals.
    let totalCommits = 0;
    let totalAdditions = 0;
    let totalDeletions = 0;
    const commitsByDate = new Map<string, DayRow>();
    for (const row of dayRows) {
      totalCommits += row.commits;
      totalAdditions += row.additions;
      totalDeletions += row.deletions;
      commitsByDate.set(row.date, row);
    }

    const totalDays = Math.round((toUTC(endIso) - toUTC(startIso)) / DAY_MS) + 1;
    const activeDays = dayRows.length;
    const avgPerActiveDay = activeDays > 0 ? Math.round((totalCommits / activeDays) * 10) / 10 : 0;

    // 6. Timeline: roll day rows up into the requested granularity, gap-filled.
    const agg = new Map<string, { commits: number; additions: number; deletions: number }>();
    for (const seq of bucketSequence(startIso, endIso, args.granularity)) {
      agg.set(seq, { commits: 0, additions: 0, deletions: 0 });
    }
    for (const row of dayRows) {
      const key = bucketOf(row.date, args.granularity);
      const b = agg.get(key);
      if (b) {
        b.commits += row.commits;
        b.additions += row.additions;
        b.deletions += row.deletions;
      }
    }
    const timeline = [...agg.entries()].map(([bucket, v]) => ({
      bucket,
      commits: v.commits,
      additions: v.additions,
      deletions: v.deletions,
    }));

    // 7. by_repo with percentages.
    const byRepo = repoRows.map((r) => ({
      repo: r.repo,
      commits: r.commits,
      percent: totalCommits > 0 ? Math.round((r.commits / totalCommits) * 1000) / 10 : 0,
    }));

    // 8. Busiest day and longest zero-commit stretch (always in days).
    let busiest: { date: string | null; commits: number } = { date: null, commits: 0 };
    for (const row of dayRows) {
      if (row.commits > busiest.commits) busiest = { date: row.date, commits: row.commits };
    }

    let quietest = 0;
    let run = 0;
    for (let d = startIso; d <= endIso; d = addDays(d, 1)) {
      if ((commitsByDate.get(d)?.commits ?? 0) === 0) {
        run += 1;
        if (run > quietest) quietest = run;
      } else {
        run = 0;
      }
    }

    // 9. Summary.
    const windowPhrase = daysRequested ? `in the last ${daysRequested} days` : `from ${startIso} to ${endIso}`;
    let summary = `${totalCommits} commits across ${byRepo.length} repos ${windowPhrase} ` +
      `(${activeDays} active days, ${avgPerActiveDay} commits per active day).`;
    if (busiest.date) summary += ` Busiest: ${fmtDay(busiest.date)} with ${busiest.commits}.`;

    return {
      summary,
      data: {
        total_commits: totalCommits,
        active_days: activeDays,
        total_days: totalDays,
        avg_commits_per_active_day: avgPerActiveDay,
        additions: totalAdditions,
        deletions: totalDeletions,
        timeline,
        by_repo: byRepo,
        busiest_day: busiest,
        quietest_stretch_days: quietest,
      },
      meta: {
        from_cache: !syncedAny,
        stale: false,
        generated_at: new Date().toISOString(),
        period: { start: startIso, end: endIso, granularity: args.granularity },
        repos_covered: byRepo.length,
      },
    };
  },
});
