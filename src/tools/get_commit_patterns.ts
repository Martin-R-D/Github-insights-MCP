import { z } from "zod";
import { formatInTimeZone } from "date-fns-tz";

import { defineTool } from "./types.js";
import { db } from "../db/client.js";
import { getRepo } from "../db/repos.js";
import { loadConfig } from "../config.js";

/**
 * MCP tool: commit *patterns* — streaks, day-of-week / hour-of-day distribution,
 * a 7x24 heatmap, and weekday-vs-weekend split. Read-only: it aggregates
 * whatever is already in SQLite (dates/hours/dows are pre-bucketed in the user's
 * TIMEZONE by the sync layer).
 */

const DAY_MS = 86_400_000;
const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const inputSchema = z
  .object({
    repo: z.string().optional(),
    days: z.number().int().min(1).max(1095).default(365),
    include_bots: z.boolean().default(false),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

// --- calendar helpers (plain YYYY-MM-DD dates as UTC midnight) ---
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
function dayDiff(a: string, b: string): number {
  return Math.round((toUTC(b) - toUTC(a)) / DAY_MS);
}
function fmtDay(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${MONTHS[m! - 1]} ${d}`;
}
function hourLabel(h: number): string {
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}
function pct(n: number, total: number): number {
  return total > 0 ? Math.round((n / total) * 1000) / 10 : 0;
}

function buildFilter(repoIds: number[] | null, includeBots: boolean, startIso: string, endIso: string) {
  const params: (string | number)[] = [startIso, endIso];
  let clause = "committed_date BETWEEN ? AND ?";
  if (repoIds !== null) {
    if (repoIds.length === 0) clause += " AND 1 = 0";
    else {
      clause += ` AND repo_id IN (${repoIds.map(() => "?").join(",")})`;
      params.push(...repoIds);
    }
  }
  if (!includeBots) clause += " AND (author_login IS NULL OR author_login NOT LIKE '%[bot]')";
  return { clause, params };
}

interface DayCount {
  date: string;
  commits: number;
}
interface Cell {
  dow: number | null;
  hour: number | null;
  commits: number;
}
interface Streak {
  start: string;
  end: string;
  days: number;
  commits: number;
}

export const getCommitPatternsTool = defineTool({
  name: "get_commit_patterns",
  description:
    "Analyze commit patterns: longest/current streaks, which day of the week and time of day you " +
    "commit most, a 7x24 heatmap, and weekday-vs-weekend split. Reads the local cache only.",
  inputSchema,
  handler: (args: Input) => {
    const { TIMEZONE: tz } = loadConfig();

    const today = formatInTimeZone(new Date(), tz, "yyyy-MM-dd");
    const endIso = today;
    const startIso = addDays(endIso, -(args.days - 1));
    const yesterday = addDays(today, -1);

    // Repo set: null = all repos; [] = requested repo not found.
    let repoIds: number[] | null = null;
    if (args.repo) {
      const row = getRepo(args.repo);
      repoIds = row ? [row.id] : [];
    }

    const { clause, params } = buildFilter(repoIds, args.include_bots, startIso, endIso);

    const dayCounts = db
      .prepare(
        `SELECT committed_date AS date, COUNT(*) AS commits
         FROM commits WHERE ${clause}
         GROUP BY committed_date ORDER BY committed_date`,
      )
      .all(...params) as DayCount[];

    const cells = db
      .prepare(
        `SELECT dow, hour, COUNT(*) AS commits
         FROM commits WHERE ${clause}
         GROUP BY dow, hour`,
      )
      .all(...params) as Cell[];

    // --- Streaks: single pass over sorted distinct dates ---
    const streaks: Streak[] = [];
    for (let i = 0; i < dayCounts.length; ) {
      let j = i;
      let commits = dayCounts[i]!.commits;
      while (j + 1 < dayCounts.length && dayDiff(dayCounts[j]!.date, dayCounts[j + 1]!.date) === 1) {
        j += 1;
        commits += dayCounts[j]!.commits;
      }
      streaks.push({ start: dayCounts[i]!.date, end: dayCounts[j]!.date, days: j - i + 1, commits });
      i = j + 1;
    }

    let longest: Streak | undefined;
    for (const s of streaks) if (!longest || s.days > longest.days) longest = s;

    const last = streaks[streaks.length - 1];
    const currentAlive = last && (last.end === today || last.end === yesterday);
    const topStreaks = [...streaks]
      .sort((a, b) => b.days - a.days || b.commits - a.commits)
      .slice(0, 5);

    // --- Distributions ---
    const dowCommits = new Array<number>(7).fill(0);
    const hourCommits = new Array<number>(24).fill(0);
    const heatmap: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    for (const c of cells) {
      if (c.dow === null || c.hour === null) continue;
      dowCommits[c.dow]! += c.commits;
      hourCommits[c.hour]! += c.commits;
      heatmap[c.dow]![c.hour]! += c.commits;
    }
    const total = dayCounts.reduce((sum, d) => sum + d.commits, 0);

    // Occurrences of each weekday within [start, end] (no day-by-day loop).
    const nDays = dayDiff(startIso, endIso) + 1;
    const occ = new Array<number>(7).fill(Math.floor(nDays / 7));
    let rem = nDays % 7;
    let d = new Date(toUTC(startIso)).getUTCDay();
    while (rem > 0) {
      occ[d]! += 1;
      d = (d + 1) % 7;
      rem -= 1;
    }

    const byDayOfWeek = DOW_NAMES.map((day, dow) => ({
      day,
      dow,
      commits: dowCommits[dow]!,
      percent: pct(dowCommits[dow]!, total),
      avg_per_occurrence: occ[dow]! > 0 ? Math.round((dowCommits[dow]! / occ[dow]!) * 100) / 100 : 0,
    }));

    const byHour = hourCommits.map((commits, hour) => ({
      hour,
      label: hourLabel(hour),
      commits,
      percent: pct(commits, total),
    }));

    const BUCKETS = [
      { bucket: "night 0-6", lo: 0, hi: 6 },
      { bucket: "morning 6-12", lo: 6, hi: 12 },
      { bucket: "afternoon 12-18", lo: 12, hi: 18 },
      { bucket: "evening 18-24", lo: 18, hi: 24 },
    ] as const;
    const byHourBucket = BUCKETS.map(({ bucket, lo, hi }) => {
      let commits = 0;
      for (let h = lo; h < hi; h++) commits += hourCommits[h]!;
      return { bucket, commits, percent: pct(commits, total) };
    });

    // Marginal peaks (argmax), null when there's no data.
    const peakDow = total > 0 ? dowCommits.indexOf(Math.max(...dowCommits)) : -1;
    const peakHour = total > 0 ? hourCommits.indexOf(Math.max(...hourCommits)) : -1;

    const weekdayCommits = dowCommits[1]! + dowCommits[2]! + dowCommits[3]! + dowCommits[4]! + dowCommits[5]!;
    const weekendCommits = dowCommits[0]! + dowCommits[6]!;
    const dowTotal = weekdayCommits + weekendCommits;

    // --- Summary ---
    let summary: string;
    if (total === 0) {
      summary = `No commits found in the last ${args.days} days.`;
    } else {
      const parts: string[] = [];
      if (longest) parts.push(`Longest streak: ${longest.days} days (${fmtDay(longest.start)} - ${fmtDay(longest.end)}).`);
      if (peakDow >= 0) {
        const dayPct = byDayOfWeek[peakDow]!.percent;
        parts.push(`You commit most on ${DOW_NAMES[peakDow]}s (${dayPct}%) and peak at ${hourLabel(peakHour)}.`);
      }
      parts.push(`${pct(weekendCommits, dowTotal)}% of your commits land on weekends.`);
      summary = parts.join(" ");
    }

    return {
      summary,
      data: {
        streaks: {
          current_streak_days: currentAlive ? last!.days : 0,
          current_streak_start: currentAlive ? last!.start : null,
          longest_streak_days: longest?.days ?? 0,
          longest_streak_start: longest?.start ?? null,
          longest_streak_end: longest?.end ?? null,
          top_streaks: topStreaks,
        },
        by_day_of_week: byDayOfWeek,
        by_hour: byHour,
        by_hour_bucket: byHourBucket,
        peak: {
          day_of_week: peakDow >= 0 ? DOW_NAMES[peakDow] : null,
          hour: peakHour >= 0 ? peakHour : null,
          hour_label: peakHour >= 0 ? hourLabel(peakHour) : null,
        },
        weekday_vs_weekend: {
          weekday_commits: weekdayCommits,
          weekend_commits: weekendCommits,
          weekend_percent: pct(weekendCommits, dowTotal),
        },
        heatmap,
      },
      meta: {
        from_cache: true,
        stale: false,
        generated_at: new Date().toISOString(),
        period: { start: startIso, end: endIso, days: args.days },
        repos_covered: repoIds === null ? null : repoIds.length,
      },
    };
  },
});
