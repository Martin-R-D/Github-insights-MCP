import { formatInTimeZone } from "date-fns-tz";
import { db } from "../db/client.js";

/**
 * Internal helpers shared by the insight tools (not itself a registered tool —
 * the underscore keeps it out of the registry conceptually). Calendar dates are
 * plain YYYY-MM-DD treated as UTC midnight.
 */

export const DAY_MS = 86_400_000;

export function toUTC(d: string): number {
  const [y, m, day] = d.split("-").map(Number);
  return Date.UTC(y!, m! - 1, day!);
}
export function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
export function addDays(d: string, n: number): string {
  return ymd(toUTC(d) + n * DAY_MS);
}
export function dayDiff(a: string, b: string): number {
  return Math.round((toUTC(b) - toUTC(a)) / DAY_MS);
}
export function mondayOf(d: string): string {
  const dow = new Date(toUTC(d)).getUTCDay(); // 0=Sun..6=Sat
  return ymd(toUTC(d) - ((dow + 6) % 7) * DAY_MS);
}
export function todayInTz(tz: string): string {
  return formatInTimeZone(new Date(), tz, "yyyy-MM-dd");
}

/** Percentage of n over total, 1 decimal; 0 when total is 0 (no divide-by-0). */
export function pct(n: number, total: number): number {
  return total > 0 ? Math.round((n / total) * 1000) / 10 : 0;
}

/** Growth percent with a zero-baseline guard: returns null instead of Infinity. */
export function growthPercent(gained: number, baseline: number): number | null {
  if (baseline <= 0) return null;
  return Math.round((gained / baseline) * 1000) / 10;
}

/** Humanize how long ago an ISO timestamp was, relative to `nowMs`. */
export function humanizeSince(iso: string | null, nowMs: number): string {
  if (!iso) return "never";
  const ms = nowMs - Date.parse(iso);
  if (Number.isNaN(ms)) return "unknown";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${Math.max(1, mins)} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/**
 * Resolve an optional repo filter to a list of repo ids.
 * Returns null when no filter was given (meaning "all repos"); an empty array
 * when a filter was given but matched nothing.
 */
export function resolveRepoIds(repo: string | undefined): number[] | null {
  if (!repo) return null;
  const byFull = db.prepare("SELECT id FROM repos WHERE full_name = ?").get(repo) as { id: number } | undefined;
  if (byFull) return [byFull.id];
  const like = `%${repo}%`;
  const rows = db
    .prepare("SELECT id FROM repos WHERE name = ? OR name LIKE ? OR full_name LIKE ? ORDER BY full_name")
    .all(repo, like, like) as { id: number }[];
  return rows.map((r) => r.id);
}

/** Build a `repo_id IN (...)` fragment (with leading AND) for a resolved set. */
export function repoInClause(repoIds: number[] | null, column = "repo_id"): { clause: string; params: number[] } {
  if (repoIds === null) return { clause: "", params: [] };
  if (repoIds.length === 0) return { clause: " AND 1 = 0", params: [] };
  return { clause: ` AND ${column} IN (${repoIds.map(() => "?").join(",")})`, params: repoIds };
}

/** Least-squares linear regression over (x=index, y). Returns slope/intercept/r². */
export function linreg(ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0 };
  const xs = ys.map((_, i) => i);
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return { slope: 0, intercept: my, r2: 0 };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2 };
}
