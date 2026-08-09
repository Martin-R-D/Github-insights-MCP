import { z } from "zod";
import { defineTool } from "./types.js";
import { db } from "../db/client.js";
import { syncStargazers } from "../services/sync.js";
import { loadConfig } from "../config.js";
import {
  addDays,
  DAY_MS,
  growthPercent,
  humanizeSince,
  repoInClause,
  resolveRepoIds,
  todayInTz,
} from "./_shared.js";

/**
 * MCP tool: stars received over a window — totals, daily gains, recent
 * stargazers, per-repo growth and the fastest-growing repo.
 */

const inputSchema = z
  .object({
    days: z.number().int().min(1).max(730).default(30),
    repo: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

interface RepoRow {
  id: number;
  name: string | null;
  full_name: string | null;
  stars: number | null;
}

export const getStarsReceivedTool = defineTool({
  name: "get_stars_received",
  description:
    "Stars received over a period: total stars, daily gains, recent stargazers, per-repo growth " +
    "and the fastest-growing repo. Syncs stargazers for repos whose star count changed.",
  inputSchema,
  handler: async (args: Input) => {
    const { TIMEZONE: tz } = loadConfig();
    const endIso = todayInTz(tz);
    const startIso = addDays(endIso, -(args.days - 1));
    const startTs = `${startIso}T00:00:00Z`;
    const nowMs = Date.now();

    const repoIds = resolveRepoIds(args.repo);
    const repos = (
      repoIds === null
        ? db.prepare("SELECT id, name, full_name, stars FROM repos").all()
        : repoIds.length === 0
          ? []
          : db
              .prepare(`SELECT id, name, full_name, stars FROM repos WHERE id IN (${repoIds.map(() => "?").join(",")})`)
              .all(...repoIds)
    ) as RepoRow[];

    // Sync stargazers for repos whose current star count differs from what we
    // have stored (i.e. it changed since last sync). If nothing has ever been
    // synced this naturally syncs everything.
    //
    // NOTE: GitHub stargazer pagination is oldest-first. For large repos the
    // cheap way to get *recent* stars is to read the last Link page and walk
    // backwards rather than paging from page 1; syncStargazers owns that
    // strategy — here we only decide *which* repos need a refresh.
    let syncedAny = false;
    const storedCounts = new Map<number, number>(
      (db.prepare("SELECT repo_id, COUNT(*) AS n FROM stargazers GROUP BY repo_id").all() as {
        repo_id: number;
        n: number;
      }[]).map((r) => [r.repo_id, r.n]),
    );
    for (const r of repos) {
      const stored = storedCounts.get(r.id) ?? 0;
      if ((r.stars ?? 0) !== stored) {
        try {
          await syncStargazers(r.id);
          syncedAny = true;
        } catch {
          // Non-fatal: fall back to whatever is cached.
        }
      }
    }

    const { clause, params } = repoInClause(repoIds);

    // Per-repo gains in the period.
    const periodByRepo = new Map<number, number>(
      (db
        .prepare(`SELECT repo_id, COUNT(*) AS n FROM stargazers WHERE starred_at >= ?${clause} GROUP BY repo_id`)
        .all(startTs, ...params) as { repo_id: number; n: number }[]).map((r) => [r.repo_id, r.n]),
    );

    // Daily gains, gap-filled.
    const dailyMap = new Map<string, number>(
      (db
        .prepare(
          `SELECT substr(starred_at,1,10) AS date, COUNT(*) AS n
           FROM stargazers WHERE starred_at >= ?${clause}
           GROUP BY date`,
        )
        .all(startTs, ...params) as { date: string; n: number }[]).map((r) => [r.date, r.n]),
    );
    const daily: { date: string; stars_gained: number }[] = [];
    for (let d = startIso; d <= endIso; d = addDays(d, 1)) {
      daily.push({ date: d, stars_gained: dailyMap.get(d) ?? 0 });
    }

    // Recent stargazers.
    const recent = (
      db
        .prepare(
          `SELECT s.user_login AS user_login,
                  COALESCE(r.full_name, r.name, 'unknown') AS repo,
                  s.starred_at AS starred_at
           FROM stargazers s LEFT JOIN repos r ON r.id = s.repo_id
           WHERE s.starred_at >= ?${clause.replace(/repo_id/g, "s.repo_id")}
           ORDER BY s.starred_at DESC
           LIMIT ?`,
        )
        .all(startTs, ...params, args.limit) as { user_login: string; repo: string; starred_at: string }[]
    ).map((s) => ({
      user_login: s.user_login,
      repo: s.repo,
      starred_at: s.starred_at,
      days_ago: Math.floor((nowMs - Date.parse(s.starred_at)) / DAY_MS),
    }));

    const totalStars = repos.reduce((sum, r) => sum + (r.stars ?? 0), 0);
    const starsInPeriod = [...periodByRepo.values()].reduce((a, b) => a + b, 0);

    // Ranks now vs at period start (stars_total - gains) for rank_change.
    const withGains = repos.map((r) => {
      const gained = periodByRepo.get(r.id) ?? 0;
      const total = r.stars ?? 0;
      return { repo: r.full_name ?? r.name ?? String(r.id), total, gained, start: total - gained };
    });
    const rankNow = new Map(
      [...withGains].sort((a, b) => b.total - a.total).map((r, i) => [r.repo, i + 1]),
    );
    const rankStart = new Map(
      [...withGains].sort((a, b) => b.start - a.start).map((r, i) => [r.repo, i + 1]),
    );

    const byRepo = withGains
      .map((r) => ({
        repo: r.repo,
        stars_total: r.total,
        stars_in_period: r.gained,
        growth_percent: growthPercent(r.gained, r.start),
        rank_change: (rankStart.get(r.repo) ?? 0) - (rankNow.get(r.repo) ?? 0),
      }))
      .sort((a, b) => b.stars_in_period - a.stars_in_period || b.stars_total - a.stars_total);

    const fastest = byRepo.reduce<(typeof byRepo)[number] | undefined>((best, r) => {
      if (!best) return r;
      if (r.stars_in_period > best.stars_in_period) return r;
      return best;
    }, undefined);

    const bestDay = daily.reduce(
      (best, d) => (d.stars_gained > best.stars_gained ? d : best),
      { date: null as string | null, stars_gained: 0 },
    );

    // Summary.
    let summary = `${totalStars} total stars, +${starsInPeriod} in the last ${args.days} days.`;
    if (fastest && fastest.stars_in_period > 0) {
      const gp = fastest.growth_percent !== null ? `, +${fastest.growth_percent}%` : "";
      summary += ` Fastest growing: ${shortName(fastest.repo)} (+${fastest.stars_in_period}${gp}).`;
    }
    if (recent[0]) {
      summary += ` Most recent: @${recent[0].user_login} starred ${shortName(recent[0].repo)} ${humanizeSince(
        recent[0].starred_at,
        nowMs,
      )}.`;
    }

    return {
      summary,
      data: {
        total_stars_all_repos: totalStars,
        stars_in_period: starsInPeriod,
        daily,
        recent_stargazers: recent,
        by_repo: byRepo,
        fastest_growing: fastest
          ? { repo: fastest.repo, stars_in_period: fastest.stars_in_period, growth_percent: fastest.growth_percent }
          : null,
        best_day: bestDay,
      },
      meta: {
        from_cache: !syncedAny,
        stale: false,
        generated_at: new Date().toISOString(),
        period: { start: startIso, end: endIso, days: args.days },
        repos_covered: repos.length,
      },
    };
  },
});

function shortName(fullName: string): string {
  const slash = fullName.indexOf("/");
  return slash >= 0 ? fullName.slice(slash + 1) : fullName;
}
