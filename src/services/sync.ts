import { formatInTimeZone } from "date-fns-tz";

import { loadConfig } from "../config.js";
import { getRepo as getRepoRow, listRepos, upsertRepo } from "../db/repos.js";
import { bulkUpsertCommits, listCommits } from "../db/commits.js";
import { bulkUpsertStargazers } from "../db/stars.js";
import { writeDailySnapshot } from "../db/snapshots.js";
import { bulkUpsertLanguages } from "../db/languages.js";
import { bulkUpsertPullRequests } from "../db/pulls.js";
import { bulkUpsertIssues } from "../db/issues.js";
import { getSyncState, upsertSyncState } from "../db/sync_state.js";
import type { CommitRow } from "../db/types.js";

import {
  getCommit,
  listIssues,
  listPullRequests,
  listRepoCommits,
  listRepoLanguages,
  listStargazersWithTimestamps,
  listUserRepos,
  type CommitSummary,
  type RepoSummary,
} from "../github/rest.js";
import { getRateLimit } from "../github/client.js";
import { logger } from "../utils/logger.js";

/**
 * Sync orchestration: pull GitHub data into the local SQLite store. Every write
 * path is an idempotent upsert, so any function here is safe to re-run.
 */

const DAY_MS = 86_400_000;
const BACKFILL_DAYS = 365;
const ENRICH_WINDOW_DAYS = 30;

function nowIso(): string {
  return new Date().toISOString();
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/**
 * Compute committed_date, hour and day-of-week in the configured TIMEZONE (not
 * UTC). `dow` is 0=Sunday .. 6=Saturday (JS getDay convention).
 */
function timeFieldsInZone(iso: string | null, tz: string): {
  date: string | null;
  hour: number | null;
  dow: number | null;
} {
  if (!iso) return { date: null, hour: null, dow: null };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: null, hour: null, dow: null };
  const isoDow = Number(formatInTimeZone(d, tz, "i")); // 1=Mon .. 7=Sun
  return {
    date: formatInTimeZone(d, tz, "yyyy-MM-dd"),
    hour: Number(formatInTimeZone(d, tz, "H")),
    dow: isoDow % 7, // Sun(7)->0, Mon(1)->1 ... Sat(6)->6
  };
}

function isMerge(c: CommitSummary): boolean {
  const parents = (c as { parents?: unknown[] }).parents;
  return Array.isArray(parents) && parents.length > 1;
}

interface OwnerRepo {
  owner: string;
  repo: string;
}

/** Resolve owner/name for a stored repo id, falling back to full_name. */
function resolveOwnerRepo(repoId: number): OwnerRepo {
  const row = getRepoRow(repoId);
  if (!row) throw new Error(`Repo id ${repoId} not found in the local store; run syncRepos first.`);
  const [fnOwner, fnName] = (row.full_name ?? "").split("/");
  const owner = row.owner ?? fnOwner;
  const repo = row.name ?? fnName;
  if (!owner || !repo) throw new Error(`Repo id ${repoId} has no resolvable owner/name.`);
  return { owner, repo };
}

function mapRepo(r: RepoSummary) {
  return {
    id: r.id,
    name: r.name,
    full_name: r.full_name,
    owner: r.owner?.login ?? null,
    private: r.private ? 1 : 0,
    fork: r.fork ? 1 : 0,
    description: r.description,
    stars: r.stargazers_count,
    forks: r.forks_count,
    watchers: r.watchers_count,
    open_issues: r.open_issues_count,
    primary_language: r.language,
    size_kb: r.size,
    default_branch: r.default_branch,
    created_at: r.created_at,
    pushed_at: r.pushed_at,
    updated_at: r.updated_at,
    archived: r.archived ? 1 : 0,
  };
}

export interface SyncedRepo {
  id: number;
  full_name: string;
  name: string;
}

/** Pull every repo accessible to the authenticated user and upsert it. */
export async function syncRepos(): Promise<SyncedRepo[]> {
  const repos = await listUserRepos({
    visibility: "all",
    affiliation: "owner,collaborator,organization_member",
  });

  const synced: SyncedRepo[] = [];
  const at = nowIso();
  for (const r of repos) {
    upsertRepo({ ...mapRepo(r), synced_at: at });
    synced.push({ id: r.id, full_name: r.full_name, name: r.name });
  }
  logger.info("syncRepos complete", { count: synced.length });
  return synced;
}

export interface SyncCommitsOptions {
  /** Lower bound (ISO). Defaults to sync_state, else 365-day backfill. */
  since?: string;
  /** Extra committer emails to attribute to the user (beyond author.login). */
  committerEmails?: string[];
  /** Fetch per-commit additions/deletions for the last 30 days (1 req each). */
  enrichRecent?: boolean;
  /** Include merge commits (skipped by default). */
  includeMerges?: boolean;
}

export interface SyncCommitsResult {
  added: number;
  enriched: number;
}

/**
 * Incrementally sync a repo's commits authored by GITHUB_USERNAME. Bulk sync
 * never fetches per-commit stats; only the trailing 30 days are enriched, and
 * only when `enrichRecent` is set.
 */
export async function syncRepoCommits(
  repoId: number,
  options: SyncCommitsOptions = {},
): Promise<SyncCommitsResult> {
  const { GITHUB_USERNAME: username, TIMEZONE: tz } = loadConfig();
  const { owner, repo } = resolveOwnerRepo(repoId);
  const resource = `commits:${repoId}`;

  const state = getSyncState(resource);
  const since = options.since ?? state?.last_synced_at ?? isoDaysAgo(BACKFILL_DAYS);

  const emails = new Set((options.committerEmails ?? []).map((e) => e.toLowerCase()));

  // When we have extra committer emails to match, we can't let the API's
  // `author` filter (login/linked-email only) exclude them — fetch broadly and
  // filter locally. Otherwise use `author` for efficiency.
  const raw =
    emails.size > 0
      ? await listRepoCommits(owner, repo, { since })
      : await listRepoCommits(owner, repo, { since, author: username });

  const rows: CommitRow[] = [];
  for (const c of raw) {
    const login = c.author?.login ?? null;
    const email = (c.commit.author?.email ?? "").toLowerCase();
    const authored = emails.size > 0 ? login === username || emails.has(email) : true;
    if (!authored) continue;
    if (!options.includeMerges && isMerge(c)) continue;

    const committedAt =
      c.commit.author?.date ?? (c.commit as { committer?: { date?: string } }).committer?.date ?? null;
    const t = timeFieldsInZone(committedAt, tz);

    rows.push({
      sha: c.sha,
      repo_id: repoId,
      author_login: login,
      author_email: c.commit.author?.email ?? null,
      committed_at: committedAt,
      committed_date: t.date,
      hour: t.hour,
      dow: t.dow,
      additions: null,
      deletions: null,
      files_changed: null,
      message: c.commit.message ?? null,
    });
  }

  const added = bulkUpsertCommits(rows);

  // Enrich only the trailing window, one request per commit.
  let enriched = 0;
  if (options.enrichRecent) {
    const cutoff = formatInTimeZone(new Date(Date.now() - ENRICH_WINDOW_DAYS * DAY_MS), tz, "yyyy-MM-dd");
    for (const r of rows) {
      if (!r.committed_date || r.committed_date < cutoff) continue;
      try {
        const full = await getCommit(owner, repo, r.sha);
        const stats = (full as { stats?: { additions?: number; deletions?: number } }).stats;
        const files = Array.isArray((full as { files?: unknown[] }).files)
          ? (full as { files: unknown[] }).files.length
          : null;
        bulkUpsertCommits([
          { ...r, additions: stats?.additions ?? null, deletions: stats?.deletions ?? null, files_changed: files },
        ]);
        enriched += 1;
      } catch (err) {
        logger.warn("Commit enrichment failed", { repoId, sha: r.sha, err: String(err) });
      }
    }
  }

  upsertSyncState({ resource, repo_id: repoId, last_synced_at: nowIso() });
  return { added, enriched };
}

/** Sync a repo's language byte counts. Returns the number of languages. */
export async function syncLanguages(repoId: number): Promise<number> {
  const { owner, repo } = resolveOwnerRepo(repoId);
  const langs = await listRepoLanguages(owner, repo);
  const n = bulkUpsertLanguages(repoId, langs);
  upsertSyncState({ resource: `languages:${repoId}`, repo_id: repoId, last_synced_at: nowIso() });
  return n;
}

/** Sync a repo's stargazers with starred_at timestamps. Returns rows written. */
export async function syncStargazers(repoId: number): Promise<number> {
  const { owner, repo } = resolveOwnerRepo(repoId);
  const stars = await listStargazersWithTimestamps(owner, repo);
  const rows = stars
    .filter((s) => s.user?.login)
    .map((s) => ({ repo_id: repoId, user_login: s.user!.login, starred_at: s.starred_at }));
  const added = bulkUpsertStargazers(rows);
  upsertSyncState({ resource: `stargazers:${repoId}`, repo_id: repoId, last_synced_at: nowIso() });
  return added;
}

export interface SyncPullsIssuesResult {
  pulls: number;
  issues: number;
}

/** Sync a repo's pull requests and issues. `since` filters by created_at. */
export async function syncPullsAndIssues(
  repoId: number,
  options: { since?: string } = {},
): Promise<SyncPullsIssuesResult> {
  const { owner, repo } = resolveOwnerRepo(repoId);
  const since = options.since;
  const keepByCreated = (createdAt: string | null) => !since || (createdAt != null && createdAt >= since);

  const pulls = (await listPullRequests(owner, repo, { state: "all" })).filter((p) =>
    keepByCreated(p.created_at),
  );
  const prRows = pulls.map((p) => ({
    id: p.id,
    repo_id: repoId,
    number: p.number,
    state: p.state,
    title: p.title,
    author_login: p.user?.login ?? null,
    created_at: p.created_at,
    merged_at: p.merged_at,
    closed_at: p.closed_at,
    additions: p.additions ?? null,
    deletions: p.deletions ?? null,
  }));
  bulkUpsertPullRequests(prRows);

  const issues = (await listIssues(owner, repo, { state: "all" })).filter((i) =>
    keepByCreated(i.created_at),
  );
  const issueRows = issues.map((i) => ({
    id: i.id,
    repo_id: repoId,
    number: i.number,
    state: i.state,
    title: i.title,
    author_login: i.user?.login ?? null,
    created_at: i.created_at,
    closed_at: i.closed_at,
    is_pull_request: i.pull_request ? 1 : 0,
  }));
  bulkUpsertIssues(issueRows);

  upsertSyncState({ resource: `pulls_issues:${repoId}`, repo_id: repoId, last_synced_at: nowIso() });
  return { pulls: prRows.length, issues: issueRows.length };
}

/**
 * Write one daily_snapshots row per repo for *today* (in TIMEZONE): stars,
 * forks, open_issues and today's commit count. Upsert on (date, repo_id) makes
 * this safe to run repeatedly per day. This is the historical record GitHub's
 * API cannot reconstruct after the fact.
 */
export function snapshotToday(): number {
  const { TIMEZONE: tz } = loadConfig();
  const today = formatInTimeZone(new Date(), tz, "yyyy-MM-dd");
  const repos = listRepos();
  for (const r of repos) {
    const commitsToday = listCommits(r.id, { from: today, to: today }).length;
    writeDailySnapshot({
      date: today,
      repo_id: r.id,
      stars: r.stars,
      forks: r.forks,
      open_issues: r.open_issues,
      commits_count: commitsToday,
    });
  }
  return repos.length;
}

export interface SyncAllOptions {
  full?: boolean;
  concurrency?: number;
  /** Limit to a single repo by full_name (owner/name) or bare name. */
  repo?: string;
}

export interface SyncReport {
  reposSynced: number;
  commitsAdded: number;
  starsAdded: number;
  errors: { repo: string; resource: string; message: string }[];
  durationMs: number;
  rateLimitRemaining: number | null;
}

/** Run a small promise pool with fixed concurrency. */
async function pool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Orchestrate a full or incremental sync across repos with a small promise
 * pool, updating sync_state after each resource and continuing past individual
 * failures. Returns a summary report.
 */
export async function syncAll(options: SyncAllOptions = {}): Promise<SyncReport> {
  const { full = false, concurrency = 4, repo } = options;
  const start = Date.now();
  const errors: SyncReport["errors"] = [];
  let commitsAdded = 0;
  let starsAdded = 0;

  const all = await syncRepos();
  const targets = repo
    ? all.filter((r) => r.full_name === repo || r.name === repo)
    : all;

  await pool(targets, concurrency, async (r) => {
    // Each resource is isolated so one failure doesn't abort the rest.
    const run = async (resource: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        errors.push({ repo: r.full_name, resource, message: err instanceof Error ? err.message : String(err) });
      }
    };

    await run("commits", async () => {
      const res = await syncRepoCommits(r.id, {
        since: full ? isoDaysAgo(BACKFILL_DAYS) : undefined,
        enrichRecent: full,
      });
      commitsAdded += res.added;
    });
    await run("stargazers", async () => {
      starsAdded += await syncStargazers(r.id);
    });
    await run("languages", async () => {
      await syncLanguages(r.id);
    });
    await run("pulls_issues", async () => {
      await syncPullsAndIssues(r.id, { since: full ? isoDaysAgo(BACKFILL_DAYS) : undefined });
    });
  });

  try {
    snapshotToday();
  } catch (err) {
    errors.push({ repo: "(all)", resource: "snapshot", message: err instanceof Error ? err.message : String(err) });
  }

  return {
    reposSynced: targets.length,
    commitsAdded,
    starsAdded,
    errors,
    durationMs: Date.now() - start,
    rateLimitRemaining: getRateLimit().remaining,
  };
}
