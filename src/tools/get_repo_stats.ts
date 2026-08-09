import { z } from "zod";
import { formatInTimeZone } from "date-fns-tz";

import { defineTool } from "./types.js";
import { db } from "../db/client.js";
import { getSnapshots } from "../db/snapshots.js";
import { getSyncState } from "../db/sync_state.js";
import {
  syncLanguages,
  syncPullsAndIssues,
  syncRepoCommits,
  syncStargazers,
} from "../services/sync.js";
import { loadConfig } from "../config.js";
import { resolveRepoRow } from "./_shared.js";

/**
 * MCP tool: a full stats dashboard for a single repo — profile, social growth,
 * commit activity, issues/PRs throughput, language mix and a snapshot-based
 * trend. Resolves the repo (fuzzy on name), syncs if stale, then aggregates.
 */

const DAY_MS = 86_400_000;
const SYNC_STALE_MS = 15 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const inputSchema = z
  .object({
    repo: z.string().min(1),
    days: z.number().int().min(1).max(3650).default(90),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!) + n * DAY_MS).toISOString().slice(0, 10);
}
function daysBetween(fromIso: string | null, nowMs: number): number | null {
  if (!fromIso) return null;
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return null;
  return Math.floor((nowMs - t) / DAY_MS);
}
function humanizeDays(days: number | null): string {
  if (days === null) return "never";
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Sync the repo's resources if any are missing or older than the threshold. */
async function ensureFresh(repoId: number, startIso: string): Promise<boolean> {
  const resources = [`commits:${repoId}`, `languages:${repoId}`, `stargazers:${repoId}`, `pulls_issues:${repoId}`];
  const now = Date.now();
  const stale = resources.some((res) => {
    const last = getSyncState(res)?.last_synced_at ?? null;
    return !last || now - Date.parse(last) > SYNC_STALE_MS;
  });
  if (!stale) return false;

  // Continue past individual failures — partial data beats none.
  await Promise.allSettled([
    syncRepoCommits(repoId, { since: startIso }),
    syncLanguages(repoId),
    syncStargazers(repoId),
    syncPullsAndIssues(repoId, { since: startIso }),
  ]);
  return true;
}

export const getRepoStatsTool = defineTool({
  name: "get_repo_stats",
  description:
    "Full stats for one repo: profile, stars/forks growth, commit activity, issue & PR throughput, " +
    "language breakdown and a snapshot-based trend. Syncs the repo first if the cache is stale.",
  inputSchema,
  handler: async (args: Input) => {
    const { TIMEZONE: tz } = loadConfig();
    const repo = resolveRepoRow(args.repo);
    const id = repo.id;

    const endIso = formatInTimeZone(new Date(), tz, "yyyy-MM-dd");
    const startIso = addDays(endIso, -(args.days - 1));
    const synced = await ensureFresh(id, startIso);
    const nowMs = Date.now();

    // --- Commit activity ---
    const commitAgg = db
      .prepare(
        `SELECT COUNT(*) AS commits,
                COUNT(DISTINCT committed_date) AS active_days,
                COALESCE(SUM(additions),0) AS additions,
                COALESCE(SUM(deletions),0) AS deletions
         FROM commits WHERE repo_id = ? AND committed_date BETWEEN ? AND ?`,
      )
      .get(id, startIso, endIso) as { commits: number; active_days: number; additions: number; deletions: number };
    const commitsAllTime = (db.prepare("SELECT COUNT(*) AS n FROM commits WHERE repo_id = ?").get(id) as { n: number }).n;
    const lastCommit = (
      db.prepare("SELECT MAX(committed_at) AS last FROM commits WHERE repo_id = ?").get(id) as { last: string | null }
    ).last;

    // --- Issues (exclude PRs) ---
    const issuesOpen = (
      db
        .prepare("SELECT COUNT(*) AS n FROM issues WHERE repo_id = ? AND is_pull_request = 0 AND state = 'open'")
        .get(id) as { n: number }
    ).n;
    const issuesClosed = db
      .prepare(
        `SELECT COUNT(*) AS n,
                AVG(julianday(closed_at) - julianday(created_at)) AS avg_days
         FROM issues
         WHERE repo_id = ? AND is_pull_request = 0 AND closed_at IS NOT NULL AND closed_at >= ?`,
      )
      .get(id, startIso) as { n: number; avg_days: number | null };

    // --- Pull requests ---
    const prsOpen = (
      db.prepare("SELECT COUNT(*) AS n FROM pull_requests WHERE repo_id = ? AND state = 'open'").get(id) as {
        n: number;
      }
    ).n;
    const prsMerged = db
      .prepare(
        `SELECT COUNT(*) AS n,
                AVG(julianday(merged_at) - julianday(created_at)) AS avg_days
         FROM pull_requests
         WHERE repo_id = ? AND merged_at IS NOT NULL AND merged_at >= ?`,
      )
      .get(id, startIso) as { n: number; avg_days: number | null };

    // --- Languages ---
    const langRows = db
      .prepare("SELECT language, bytes FROM repo_languages WHERE repo_id = ? ORDER BY bytes DESC")
      .all(id) as { language: string; bytes: number }[];
    const totalBytes = langRows.reduce((s, l) => s + (l.bytes ?? 0), 0);
    const languages = langRows.map((l) => ({
      language: l.language,
      bytes: l.bytes,
      percent: totalBytes > 0 ? round1((l.bytes / totalBytes) * 100) : 0,
    }));

    // --- Social / stars ---
    const currentStars = repo.stars ?? 0;
    const snaps = getSnapshots(id, { from: startIso, to: endIso });
    const starEventsInPeriod = (
      db.prepare("SELECT COUNT(*) AS n FROM stargazers WHERE repo_id = ? AND starred_at >= ?").get(id, startIso) as {
        n: number;
      }
    ).n;

    let starsGained: number;
    let starGrowthPercent: number | null;
    let note: string | undefined;
    if (snaps.length >= 2) {
      const baseline = snaps[0]!.stars ?? 0;
      starsGained = currentStars - baseline;
      starGrowthPercent = baseline > 0 ? round1((starsGained / baseline) * 100) : null;
    } else {
      // Snapshot history hasn't accumulated yet: fall back to star events.
      starsGained = starEventsInPeriod;
      starGrowthPercent = null;
      note = "Star trend history starts accumulating from the first sync; growth % needs at least 2 daily snapshots.";
    }

    const trend = snaps.map((s) => ({ date: s.date, stars: s.stars ?? 0, commits: s.commits_count ?? 0 }));

    const daysSinceLastCommit = daysBetween(lastCommit, nowMs);
    const topLang = languages[0];

    // --- Summary ---
    const gainStr = starGrowthPercent !== null
      ? `+${starsGained} in ${args.days}d, ${starGrowthPercent >= 0 ? "+" : ""}${starGrowthPercent}%`
      : `+${starsGained} in ${args.days}d`;
    const langStr = topLang ? ` ${topLang.percent}% ${topLang.language}.` : "";
    const summary =
      `${repo.name}: ${currentStars} stars (${gainStr}), ` +
      `${commitAgg.commits} commits over ${commitAgg.active_days} active days, ` +
      `last push ${humanizeDays(daysSinceLastCommit)}.${langStr} ` +
      `${issuesOpen} open issues, ${prsOpen} open PRs.`;

    return {
      summary,
      data: {
        repo: {
          name: repo.name,
          full_name: repo.full_name,
          description: repo.description,
          url: repo.full_name ? `https://github.com/${repo.full_name}` : null,
          created_at: repo.created_at,
          pushed_at: repo.pushed_at,
          age_days: daysBetween(repo.created_at, nowMs),
          private: Boolean(repo.private),
          fork: Boolean(repo.fork),
          archived: Boolean(repo.archived),
          default_branch: repo.default_branch,
          size_kb: repo.size_kb ?? 0,
        },
        social: {
          stars: currentStars,
          forks: repo.forks ?? 0,
          watchers: repo.watchers ?? 0,
          stars_gained_in_period: starsGained,
          star_growth_percent: starGrowthPercent,
        },
        activity: {
          commits_in_period: commitAgg.commits,
          commits_all_time: commitsAllTime,
          active_days: commitAgg.active_days,
          last_commit_at: lastCommit,
          days_since_last_commit: daysSinceLastCommit,
          additions: commitAgg.additions,
          deletions: commitAgg.deletions,
        },
        issues: {
          open: issuesOpen,
          closed_in_period: issuesClosed.n,
          avg_days_to_close: issuesClosed.avg_days !== null ? round1(issuesClosed.avg_days) : null,
        },
        pull_requests: {
          open: prsOpen,
          merged_in_period: prsMerged.n,
          avg_days_to_merge: prsMerged.avg_days !== null ? round1(prsMerged.avg_days) : null,
        },
        languages,
        trend,
      },
      meta: {
        from_cache: !synced,
        stale: false,
        generated_at: new Date().toISOString(),
        period: { start: startIso, end: endIso, days: args.days },
        repos_covered: 1,
        ...(note ? { note } : {}),
      },
    };
  },
});
