import { formatInTimeZone } from "date-fns-tz";
import { db } from "../db/client.js";
import { loadConfig } from "../config.js";
import { syncAll } from "./sync.js";

/**
 * Weekly report generator. This is the one place that fans out: it runs a fresh
 * syncAll() (skipped if a sync completed under 10 minutes ago), then computes
 * every section in parallel with Promise.allSettled so a single failing section
 * degrades to null + a meta.partial_failures entry instead of failing the whole
 * report.
 *
 * Week boundaries are Monday 00:00 to Sunday 23:59 in the configured TIMEZONE.
 */

const DAY_MS = 86_400_000;
const SYNC_SKIP_MS = 10 * 60 * 1000;
const STALE_PR_DAYS = 14;
const TRAJECTORY_WEEKS = 12;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const SECURITY_RE = /(security|vulnerab|\bCVE\b|exploit|\bXSS\b|injection|\bRCE\b)/i;
const BUG_RE = /(\bbug\b|regression|\bcrash\b|broken|fails?\b|error)/i;

// --- date helpers (plain YYYY-MM-DD as UTC midnight) ---
function toUTC(d: string): number {
  const [y, m, day] = d.split("-").map(Number);
  return Date.UTC(y!, m! - 1, day!);
}
function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function addDays(d: string, n: number): string {
  return ymd(toUTC(d) + n * DAY_MS);
}
function mondayOf(d: string): string {
  const dow = new Date(toUTC(d)).getUTCDay();
  return ymd(toUTC(d) - ((dow + 6) % 7) * DAY_MS);
}
function fmtShort(d: string): string {
  const [, m, day] = d.split("-").map(Number);
  return `${MONTHS[m! - 1]} ${day}`;
}
function hourLabel(h: number): string {
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

// --- small stats ---
function delta(cur: number, prev: number) {
  const abs = cur - prev;
  const percent = prev === 0 ? null : Math.round((abs / prev) * 1000) / 10;
  return { abs, percent, direction: abs > 0 ? "up" : abs < 0 ? "down" : "flat" } as const;
}
function linreg(ys: number[]): { slope: number; r2: number } {
  const n = ys.length;
  if (n < 2) return { slope: 0, r2: 0 };
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - mx;
    const dy = ys[i]! - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return { slope: 0, r2: 0 };
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, r2 };
}

// --------------------------------------------------------------------------
// Week resolution (exported for testing)
// --------------------------------------------------------------------------
export interface WeekWindow {
  start: string;
  end: string;
  label: string;
}
export interface ResolveOpts {
  week_offset?: number;
  start_date?: string;
  end_date?: string;
}
export function resolveWeek(opts: ResolveOpts, today: string): WeekWindow {
  let start: string;
  let end: string;
  if (opts.start_date && opts.end_date) {
    start = opts.start_date.slice(0, 10);
    end = opts.end_date.slice(0, 10);
  } else {
    const monday = mondayOf(today);
    start = addDays(monday, -7 * (opts.week_offset ?? 0));
    end = addDays(start, 6);
  }
  const [ey] = end.split("-");
  const label = `${fmtShort(start)} - ${fmtShort(end)}, ${ey}`;
  return { start, end, label };
}

// --------------------------------------------------------------------------
// Section context + implementations
// --------------------------------------------------------------------------
interface Ctx {
  startIso: string;
  endIso: string;
  startTs: string;
  endTs: string;
  prevStartIso: string;
  prevEndIso: string;
  prevStartTs: string;
  prevEndTs: string;
  username: string;
  compare: boolean;
}

interface Headline {
  commits: number;
  repos_touched: number;
  prs_merged: number;
  issues_closed: number;
  stars_gained: number;
  active_days: number;
  net_lines: number;
}

function computeHeadline(startIso: string, endIso: string, startTs: string, endTs: string, username: string): Headline {
  const c = db
    .prepare(
      `SELECT COUNT(*) AS commits, COUNT(DISTINCT repo_id) AS repos, COUNT(DISTINCT committed_date) AS active,
              COALESCE(SUM(additions),0) AS adds, COALESCE(SUM(deletions),0) AS dels
       FROM commits WHERE committed_date BETWEEN ? AND ?`,
    )
    .get(startIso, endIso) as { commits: number; repos: number; active: number; adds: number; dels: number };
  const prsMerged = (
    db.prepare("SELECT COUNT(*) AS n FROM pull_requests WHERE author_login = ? AND merged_at BETWEEN ? AND ?").get(username, startTs, endTs) as { n: number }
  ).n;
  const issuesClosed = (
    db.prepare("SELECT COUNT(*) AS n FROM issues WHERE is_pull_request = 0 AND author_login = ? AND closed_at BETWEEN ? AND ?").get(username, startTs, endTs) as { n: number }
  ).n;
  const starsGained = (
    db.prepare("SELECT COUNT(*) AS n FROM stargazers WHERE starred_at BETWEEN ? AND ?").get(startTs, endTs) as { n: number }
  ).n;
  return {
    commits: c.commits,
    repos_touched: c.repos,
    prs_merged: prsMerged,
    issues_closed: issuesClosed,
    stars_gained: starsGained,
    active_days: c.active,
    net_lines: c.adds - c.dels,
  };
}

const sections: Record<string, (ctx: Ctx) => Promise<unknown>> = {
  headline: async (ctx) => computeHeadline(ctx.startIso, ctx.endIso, ctx.startTs, ctx.endTs, ctx.username),

  vs_last_week: async (ctx) => {
    if (!ctx.compare) return null;
    const cur = computeHeadline(ctx.startIso, ctx.endIso, ctx.startTs, ctx.endTs, ctx.username);
    const prev = computeHeadline(ctx.prevStartIso, ctx.prevEndIso, ctx.prevStartTs, ctx.prevEndTs, ctx.username);
    const keys: (keyof Headline)[] = [
      "commits", "repos_touched", "prs_merged", "issues_closed", "stars_gained", "active_days", "net_lines",
    ];
    return Object.fromEntries(keys.map((k) => [k, delta(cur[k], prev[k])]));
  },

  by_repo: async (ctx) => {
    const rows = db
      .prepare(
        `SELECT c.repo_id AS repo_id, COALESCE(r.full_name, r.name, 'unknown') AS repo,
                COUNT(*) AS commits, COALESCE(SUM(additions),0) AS additions, COALESCE(SUM(deletions),0) AS deletions
         FROM commits c LEFT JOIN repos r ON r.id = c.repo_id
         WHERE committed_date BETWEEN ? AND ?
         GROUP BY c.repo_id ORDER BY commits DESC`,
      )
      .all(ctx.startIso, ctx.endIso) as { repo_id: number; repo: string; commits: number; additions: number; deletions: number }[];

    return rows.map((r) => {
      const prsMerged = (
        db.prepare("SELECT COUNT(*) AS n FROM pull_requests WHERE repo_id = ? AND author_login = ? AND merged_at BETWEEN ? AND ?").get(r.repo_id, ctx.username, ctx.startTs, ctx.endTs) as { n: number }
      ).n;
      const issuesClosed = (
        db.prepare("SELECT COUNT(*) AS n FROM issues WHERE repo_id = ? AND is_pull_request = 0 AND author_login = ? AND closed_at BETWEEN ? AND ?").get(r.repo_id, ctx.username, ctx.startTs, ctx.endTs) as { n: number }
      ).n;
      const starsGained = (
        db.prepare("SELECT COUNT(*) AS n FROM stargazers WHERE repo_id = ? AND starred_at BETWEEN ? AND ?").get(r.repo_id, ctx.startTs, ctx.endTs) as { n: number }
      ).n;
      const highlight = db
        .prepare(
          `SELECT message FROM commits WHERE repo_id = ? AND committed_date BETWEEN ? AND ?
           ORDER BY (COALESCE(additions,0)+COALESCE(deletions,0)) DESC, committed_at DESC LIMIT 1`,
        )
        .get(r.repo_id, ctx.startIso, ctx.endIso) as { message: string | null } | undefined;
      return {
        repo: r.repo,
        commits: r.commits,
        additions: r.additions,
        deletions: r.deletions,
        prs_merged: prsMerged,
        issues_closed: issuesClosed,
        stars_gained: starsGained,
        highlight_commit_message: (highlight?.message ?? "").split("\n")[0] || null,
      };
    });
  },

  daily: async (ctx) => {
    const byDate = new Map(
      (db
        .prepare("SELECT committed_date AS date, COUNT(*) AS n FROM commits WHERE committed_date BETWEEN ? AND ? GROUP BY committed_date")
        .all(ctx.startIso, ctx.endIso) as { date: string; n: number }[]).map((r) => [r.date, r.n]),
    );
    const out: { date: string; day_name: string; commits: number; is_active: boolean }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(ctx.startIso, i);
      const commits = byDate.get(d) ?? 0;
      out.push({ date: d, day_name: DOW_NAMES[new Date(toUTC(d)).getUTCDay()]!, commits, is_active: commits > 0 });
    }
    return out;
  },

  languages_used: async (ctx) => {
    const repoIds = (
      db.prepare("SELECT DISTINCT repo_id FROM commits WHERE committed_date BETWEEN ? AND ?").all(ctx.startIso, ctx.endIso) as { repo_id: number }[]
    ).map((r) => r.repo_id);
    if (repoIds.length === 0) return [];
    const rows = db
      .prepare(
        `SELECT l.language AS language, COALESCE(SUM(l.bytes),0) AS bytes, COUNT(DISTINCT l.repo_id) AS repo_count,
                GROUP_CONCAT(DISTINCT COALESCE(r.full_name, r.name)) AS repos
         FROM repo_languages l LEFT JOIN repos r ON r.id = l.repo_id
         WHERE l.repo_id IN (${repoIds.map(() => "?").join(",")})
         GROUP BY l.language`,
      )
      .all(...repoIds) as { language: string; bytes: number; repo_count: number; repos: string | null }[];
    const total = rows.reduce((s, r) => s + r.bytes, 0);
    return rows
      .map((r) => ({
        language: r.language,
        percent: total > 0 ? Math.round((r.bytes / total) * 1000) / 10 : 0,
        repos: (r.repos ?? "").split(",").filter(Boolean),
      }))
      .sort((a, b) => b.percent - a.percent)
      .slice(0, 15);
  },

  shipped: async (ctx) => {
    const prs = db
      .prepare(
        `SELECT COALESCE(r.full_name, r.name, 'unknown') AS repo, p.number AS number, p.title AS title, p.merged_at AS merged_at
         FROM pull_requests p LEFT JOIN repos r ON r.id = p.repo_id
         WHERE p.author_login = ? AND p.merged_at BETWEEN ? AND ? ORDER BY p.merged_at DESC`,
      )
      .all(ctx.username, ctx.startTs, ctx.endTs);
    const issues = db
      .prepare(
        `SELECT COALESCE(r.full_name, r.name, 'unknown') AS repo, i.number AS number, i.title AS title
         FROM issues i LEFT JOIN repos r ON r.id = i.repo_id
         WHERE i.is_pull_request = 0 AND i.author_login = ? AND i.closed_at BETWEEN ? AND ? ORDER BY i.closed_at DESC`,
      )
      .all(ctx.username, ctx.startTs, ctx.endTs);
    return { prs_merged: prs, issues_closed: issues };
  },

  community: async (ctx) => {
    const stargazers = db
      .prepare(
        `SELECT s.user_login AS user, COALESCE(r.full_name, r.name, 'unknown') AS repo
         FROM stargazers s LEFT JOIN repos r ON r.id = s.repo_id
         WHERE s.starred_at BETWEEN ? AND ? ORDER BY s.starred_at DESC LIMIT 100`,
      )
      .all(ctx.startTs, ctx.endTs);
    const issuesFromOthers = (
      db.prepare("SELECT COUNT(*) AS n FROM issues WHERE is_pull_request = 0 AND author_login <> ? AND created_at BETWEEN ? AND ?").get(ctx.username, ctx.startTs, ctx.endTs) as { n: number }
    ).n;
    const prsFromOthers = (
      db.prepare("SELECT COUNT(*) AS n FROM pull_requests WHERE author_login <> ? AND created_at BETWEEN ? AND ?").get(ctx.username, ctx.startTs, ctx.endTs) as { n: number }
    ).n;
    return { new_stargazers: stargazers, new_issues_from_others: issuesFromOthers, new_prs_from_others: prsFromOthers };
  },

  patterns: async (ctx) => {
    const cells = db
      .prepare("SELECT dow, hour, COUNT(*) AS n FROM commits WHERE committed_date BETWEEN ? AND ? GROUP BY dow, hour")
      .all(ctx.startIso, ctx.endIso) as { dow: number | null; hour: number | null; n: number }[];
    const dowCount = new Array(7).fill(0);
    const hourCount = new Array(24).fill(0);
    let total = 0;
    for (const c of cells) {
      total += c.n;
      if (c.dow !== null) dowCount[c.dow] += c.n;
      if (c.hour !== null) hourCount[c.hour] += c.n;
    }
    const peakDow = total > 0 ? dowCount.indexOf(Math.max(...dowCount)) : -1;
    const peakHour = total > 0 ? hourCount.indexOf(Math.max(...hourCount)) : -1;
    const weekend = (dowCount[0] ?? 0) + (dowCount[6] ?? 0);

    // Current streak: consecutive days with commits ending at (or one day before) end.
    const dates = new Set(
      (db.prepare("SELECT DISTINCT committed_date AS d FROM commits WHERE committed_date <= ? ORDER BY committed_date DESC LIMIT 400").all(ctx.endIso) as { d: string }[]).map((r) => r.d),
    );
    let anchor = ctx.endIso;
    if (!dates.has(anchor)) anchor = addDays(ctx.endIso, -1);
    let streak = 0;
    if (dates.has(anchor)) {
      let d = anchor;
      while (dates.has(d)) {
        streak += 1;
        d = addDays(d, -1);
      }
    }
    return {
      peak_day: peakDow >= 0 ? DOW_NAMES[peakDow] : null,
      peak_hour: peakHour >= 0 ? { hour: peakHour, label: hourLabel(peakHour) } : null,
      weekend_percent: total > 0 ? Math.round((weekend / total) * 1000) / 10 : 0,
      current_streak_days: streak,
    };
  },

  attention: async (ctx) => {
    interface Cand { type: "pr" | "issue"; repo: string; number: number; title: string | null; reason: string; priority: number; age: number }
    const now = Date.now();
    const cands: Cand[] = [];
    const openPrs = db
      .prepare(
        `SELECT COALESCE(r.full_name, r.name, 'unknown') AS repo, p.number AS number, p.title AS title, p.created_at AS created_at
         FROM pull_requests p LEFT JOIN repos r ON r.id = p.repo_id WHERE p.state = 'open'`,
      )
      .all() as { repo: string; number: number; title: string | null; created_at: string | null }[];
    for (const p of openPrs) {
      const age = p.created_at ? Math.floor((now - Date.parse(p.created_at)) / DAY_MS) : 0;
      const t = p.title ?? "";
      if (SECURITY_RE.test(t)) cands.push({ type: "pr", repo: p.repo, number: p.number, title: p.title, reason: "labeled security", priority: 0, age });
      else if (BUG_RE.test(t)) cands.push({ type: "pr", repo: p.repo, number: p.number, title: p.title, reason: "labeled bug", priority: 1, age });
      if (age > STALE_PR_DAYS) cands.push({ type: "pr", repo: p.repo, number: p.number, title: p.title, reason: `PR open ${age} days (stale)`, priority: 2, age });
    }
    const openIssues = db
      .prepare(
        `SELECT COALESCE(r.full_name, r.name, 'unknown') AS repo, i.number AS number, i.title AS title, i.author_login AS author, i.created_at AS created_at
         FROM issues i LEFT JOIN repos r ON r.id = i.repo_id WHERE i.state = 'open' AND i.is_pull_request = 0`,
      )
      .all() as { repo: string; number: number; title: string | null; author: string | null; created_at: string | null }[];
    for (const i of openIssues) {
      const age = i.created_at ? Math.floor((now - Date.parse(i.created_at)) / DAY_MS) : 0;
      const t = i.title ?? "";
      if (SECURITY_RE.test(t)) cands.push({ type: "issue", repo: i.repo, number: i.number, title: i.title, reason: "labeled security", priority: 0, age });
      else if (BUG_RE.test(t)) cands.push({ type: "issue", repo: i.repo, number: i.number, title: i.title, reason: "labeled bug", priority: 1, age });
      else if (i.author !== ctx.username) cands.push({ type: "issue", repo: i.repo, number: i.number, title: i.title, reason: "external issue awaiting reply", priority: 3, age });
    }
    const best = new Map<string, Cand>();
    for (const c of cands) {
      const key = `${c.type}:${c.repo}#${c.number}`;
      const prev = best.get(key);
      if (!prev || c.priority < prev.priority) best.set(key, c);
    }
    return [...best.values()]
      .sort((a, b) => a.priority - b.priority || b.age - a.age)
      .slice(0, 15)
      .map((c) => ({ type: c.type, repo: c.repo, number: c.number, title: c.title, reason: c.reason }));
  },

  trajectory: async (ctx) => {
    const weekly: number[] = [];
    for (let i = TRAJECTORY_WEEKS - 1; i >= 0; i--) {
      const wStart = addDays(ctx.startIso, -7 * i);
      const wEnd = addDays(wStart, 6);
      const n = (db.prepare("SELECT COUNT(*) AS n FROM commits WHERE committed_date BETWEEN ? AND ?").get(wStart, wEnd) as { n: number }).n;
      weekly.push(n);
    }
    const { slope, r2 } = linreg(weekly);
    const points = weekly.length;
    const confidence = points < 6 || r2 < 0.3 ? "low" : points >= 12 && r2 >= 0.6 ? "high" : "medium";
    const direction = slope > 0.05 ? "rising" : slope < -0.05 ? "falling" : "flat";
    return { direction, slope_commits_per_week: Math.round(slope * 100) / 100, confidence };
  },
};

// --------------------------------------------------------------------------
// Sync gating (with a test seam)
// --------------------------------------------------------------------------
type SyncRunner = () => Promise<unknown>;
let syncRunner: SyncRunner = () => syncAll({});
/** @internal test hook */
export function __setSyncRunner(fn: SyncRunner | null): void {
  syncRunner = fn ?? (() => syncAll({}));
}

function recentlySynced(): boolean {
  const row = db.prepare("SELECT MAX(last_synced_at) AS last FROM sync_state").get() as { last: string | null };
  if (!row.last) return false;
  return Date.now() - Date.parse(row.last) < SYNC_SKIP_MS;
}

// --------------------------------------------------------------------------
// Public entry
// --------------------------------------------------------------------------
export interface ReportParams {
  week_offset?: number;
  start_date?: string;
  end_date?: string;
  compare?: boolean;
  format?: "structured" | "markdown";
  /** @internal test override to force a section to reject/return. */
  sectionOverrides?: Record<string, (ctx: Ctx) => Promise<unknown>>;
}

export async function generateWeeklyReport(params: ReportParams = {}) {
  const { GITHUB_USERNAME: username, TIMEZONE: tz } = loadConfig();
  const compare = params.compare ?? true;
  const format = params.format ?? "structured";

  const today = formatInTimeZone(new Date(), tz, "yyyy-MM-dd");
  const week = resolveWeek(params, today);

  const prevEndIso = addDays(week.start, -1);
  const prevStartIso = addDays(prevEndIso, -6);
  const ctx: Ctx = {
    startIso: week.start,
    endIso: week.end,
    startTs: `${week.start}T00:00:00Z`,
    endTs: `${week.end}T23:59:59Z`,
    prevStartIso,
    prevEndIso,
    prevStartTs: `${prevStartIso}T00:00:00Z`,
    prevEndTs: `${prevEndIso}T23:59:59Z`,
    username,
    compare,
  };

  // Fan-out step 0: fresh sync unless one completed recently.
  let synced = false;
  if (!recentlySynced()) {
    try {
      await syncRunner();
      synced = true;
    } catch {
      // A failed sync shouldn't abort the report; sections run on cached data.
    }
  }

  // Fan out every section in parallel; isolate failures.
  const runners = { ...sections, ...(params.sectionOverrides ?? {}) };
  const names = Object.keys(sections); // fixed section set (overrides replace by name)
  const results = await Promise.allSettled(names.map((n) => runners[n]!(ctx)));

  const data: Record<string, unknown> = { week };
  const partialFailures: string[] = [];
  names.forEach((n, i) => {
    const r = results[i]!;
    if (r.status === "fulfilled") data[n] = r.value;
    else {
      data[n] = null;
      partialFailures.push(n);
    }
  });

  const summary = buildSummary(data);
  if (format === "markdown") data.markdown = buildMarkdown(data);

  return {
    summary,
    data,
    meta: {
      from_cache: !synced,
      stale: false,
      generated_at: new Date().toISOString(),
      period: { start: week.start, end: week.end },
      repos_covered: Array.isArray(data.by_repo) ? (data.by_repo as unknown[]).length : null,
      partial_failures: partialFailures,
    },
  };
}

// --------------------------------------------------------------------------
// Rendering (every line traces to a number in `data`)
// --------------------------------------------------------------------------
function fmtDelta(d: { abs: number; percent: number | null } | undefined): string {
  if (!d) return "";
  if (d.percent === null) return ` (${d.abs >= 0 ? "+" : ""}${d.abs} vs last week)`;
  return ` (${d.percent >= 0 ? "+" : ""}${d.percent}% vs last week)`;
}

function buildSummary(data: Record<string, unknown>): string {
  const week = data.week as { label: string };
  const h = data.headline as Headline | null;
  const vs = data.vs_last_week as Record<string, { percent: number | null; abs: number }> | null;
  const traj = data.trajectory as { direction: string; slope_commits_per_week: number; confidence: string } | null;

  if (!h) return `Weekly report for ${week.label}. Headline metrics were unavailable this run.`;

  const cmp = vs?.commits ? fmtDelta(vs.commits).trim() : "";
  let s = `For ${week.label}, you made ${h.commits} commits across ${h.repos_touched} repos${cmp ? ` ${cmp}` : ""}.`;
  s += ` You merged ${h.prs_merged} pull requests, closed ${h.issues_closed} issues, and gained ${h.stars_gained} stars over ${h.active_days} active days.`;
  if (traj) s += ` Your 12-week trend is ${traj.direction} at ${traj.slope_commits_per_week} commits per week (${traj.confidence} confidence).`;
  return s;
}

function buildMarkdown(data: Record<string, unknown>): string {
  const week = data.week as { label: string };
  const h = data.headline as Headline | null;
  const vs = data.vs_last_week as Record<string, { abs: number; percent: number | null }> | null;
  const byRepo = (data.by_repo as { repo: string; commits: number; additions: number; deletions: number }[] | null) ?? [];
  const langs = (data.languages_used as { language: string; percent: number }[] | null) ?? [];
  const shipped = data.shipped as { prs_merged: { repo: string; number: number; title: string }[]; issues_closed: { repo: string; number: number; title: string }[] } | null;
  const community = data.community as { new_stargazers: { user: string; repo: string }[]; new_issues_from_others: number; new_prs_from_others: number } | null;
  const patterns = data.patterns as { peak_day: string | null; peak_hour: { label: string } | null; weekend_percent: number; current_streak_days: number } | null;
  const attention = (data.attention as { type: string; repo: string; number: number; title: string | null; reason: string }[] | null) ?? [];

  const L: string[] = [];
  L.push(`# Weekly report: ${week.label}`, "");

  L.push("## Headline");
  if (h) {
    L.push(`- Commits: ${h.commits}${fmtDelta(vs?.commits)}`);
    L.push(`- Repos touched: ${h.repos_touched}${fmtDelta(vs?.repos_touched)}`);
    L.push(`- PRs merged: ${h.prs_merged}${fmtDelta(vs?.prs_merged)}`);
    L.push(`- Issues closed: ${h.issues_closed}${fmtDelta(vs?.issues_closed)}`);
    L.push(`- Stars gained: ${h.stars_gained}${fmtDelta(vs?.stars_gained)}`);
    L.push(`- Active days: ${h.active_days}/7`);
    L.push(`- Net lines: ${h.net_lines >= 0 ? "+" : ""}${h.net_lines}`);
  } else {
    L.push("- (headline unavailable)");
  }
  L.push("");

  L.push("## What shipped");
  const prs = shipped?.prs_merged ?? [];
  const iss = shipped?.issues_closed ?? [];
  if (prs.length === 0 && iss.length === 0) L.push("- Nothing merged or closed this week.");
  for (const p of prs) L.push(`- Merged PR #${p.number} ${firstLine(p.title)} (${p.repo})`);
  for (const i of iss) L.push(`- Closed issue #${i.number} ${firstLine(i.title)} (${i.repo})`);
  L.push("");

  L.push("## Where the work went");
  if (byRepo.length === 0) L.push("- No commits this week.");
  for (const r of byRepo) L.push(`- ${r.repo}: ${r.commits} commits (+${r.additions}/-${r.deletions})`);
  if (langs.length) L.push(`- Languages: ${langs.slice(0, 5).map((l) => `${l.language} ${l.percent}%`).join(", ")}`);
  L.push("");

  L.push("## Patterns");
  if (patterns) {
    L.push(`- Peak day: ${patterns.peak_day ?? "none"}`);
    L.push(`- Peak hour: ${patterns.peak_hour?.label ?? "none"}`);
    L.push(`- Weekend share: ${patterns.weekend_percent}%`);
    L.push(`- Current streak: ${patterns.current_streak_days} days`);
  } else {
    L.push("- (patterns unavailable)");
  }
  L.push("");

  L.push("## Community");
  if (community) {
    L.push(`- New stargazers: ${community.new_stargazers.length}`);
    L.push(`- New issues from others: ${community.new_issues_from_others}`);
    L.push(`- New PRs from others: ${community.new_prs_from_others}`);
  } else {
    L.push("- (community unavailable)");
  }
  L.push("");

  L.push("## Needs attention");
  if (attention.length === 0) L.push("- Nothing needs attention.");
  for (const a of attention) L.push(`- ${a.reason}: ${a.repo} #${a.number} ${firstLine(a.title)}`);

  return L.join("\n");
}

function firstLine(title: string | null): string {
  return (title ?? "").split("\n")[0] ?? "";
}
