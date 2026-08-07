import { db } from "./client.js";
import type { RepoRow } from "./types.js";

/**
 * Repository CRUD for the `repos` table. All statements are prepared once at
 * module load. Every write is an idempotent UPSERT keyed on the repo id.
 */

export type RepoInput = Omit<RepoRow, "synced_at"> & { synced_at?: string | null };

const upsertStmt = db.prepare(
  `INSERT INTO repos (
     id, name, full_name, owner, private, fork, description, stars, forks,
     watchers, open_issues, primary_language, size_kb, default_branch,
     created_at, pushed_at, updated_at, archived, synced_at
   ) VALUES (
     @id, @name, @full_name, @owner, @private, @fork, @description, @stars,
     @forks, @watchers, @open_issues, @primary_language, @size_kb,
     @default_branch, @created_at, @pushed_at, @updated_at, @archived, @synced_at
   )
   ON CONFLICT(id) DO UPDATE SET
     name             = excluded.name,
     full_name        = excluded.full_name,
     owner            = excluded.owner,
     private          = excluded.private,
     fork             = excluded.fork,
     description      = excluded.description,
     stars            = excluded.stars,
     forks            = excluded.forks,
     watchers         = excluded.watchers,
     open_issues      = excluded.open_issues,
     primary_language = excluded.primary_language,
     size_kb          = excluded.size_kb,
     default_branch   = excluded.default_branch,
     created_at       = excluded.created_at,
     pushed_at        = excluded.pushed_at,
     updated_at       = excluded.updated_at,
     archived         = excluded.archived,
     synced_at        = excluded.synced_at`,
);

const getByFullNameStmt = db.prepare<[string]>(
  "SELECT * FROM repos WHERE full_name = ?",
);
const getByNameStmt = db.prepare<[string]>("SELECT * FROM repos WHERE name = ?");
const getByIdStmt = db.prepare<[number]>("SELECT * FROM repos WHERE id = ?");

const updateStatsStmt = db.prepare(
  `UPDATE repos SET
     stars       = @stars,
     forks       = @forks,
     watchers    = @watchers,
     open_issues = @open_issues,
     synced_at   = @synced_at
   WHERE id = @id`,
);

function nowIso(): string {
  return new Date().toISOString();
}

/** Insert or update a repo. Idempotent on `id`. */
export function upsertRepo(repo: RepoInput): void {
  upsertStmt.run({ ...repo, synced_at: repo.synced_at ?? nowIso() });
}

/**
 * Fetch a repo by numeric id, `full_name` (owner/name), or bare `name`.
 * Tries full_name first, then name.
 */
export function getRepo(nameOrFullName: string | number): RepoRow | undefined {
  if (typeof nameOrFullName === "number") {
    return getByIdStmt.get(nameOrFullName) as RepoRow | undefined;
  }
  const byFull = getByFullNameStmt.get(nameOrFullName) as RepoRow | undefined;
  if (byFull) return byFull;
  return getByNameStmt.get(nameOrFullName) as RepoRow | undefined;
}

export interface ListReposOptions {
  includeForks?: boolean;
  includeArchived?: boolean;
  includePrivate?: boolean;
}

/**
 * List repos with boolean filters. Each flag defaults to `true` (include
 * everything); set to `false` to exclude forks / archived / private repos.
 */
export function listRepos(options: ListReposOptions = {}): RepoRow[] {
  const {
    includeForks = true,
    includeArchived = true,
    includePrivate = true,
  } = options;

  const where: string[] = [];
  if (!includeForks) where.push("COALESCE(fork, 0) = 0");
  if (!includeArchived) where.push("COALESCE(archived, 0) = 0");
  if (!includePrivate) where.push("COALESCE(private, 0) = 0");

  const sql =
    "SELECT * FROM repos" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY COALESCE(stars, 0) DESC, full_name ASC";

  // Filters are a small fixed set; prepare on demand (statement cache in SQLite
  // makes this cheap) rather than precomputing all 8 combinations.
  return db.prepare(sql).all() as RepoRow[];
}

export interface RepoStatsUpdate {
  id: number;
  stars: number | null;
  forks: number | null;
  watchers: number | null;
  open_issues: number | null;
  synced_at?: string | null;
}

/** Update only the volatile stat columns for a repo. */
export function updateRepoStats(update: RepoStatsUpdate): void {
  updateStatsStmt.run({ ...update, synced_at: update.synced_at ?? nowIso() });
}
