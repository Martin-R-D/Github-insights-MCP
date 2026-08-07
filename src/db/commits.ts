import { db } from "./client.js";
import type { CommitRow, DateRange } from "./types.js";

/**
 * Commit persistence. `bulkUpsertCommits` writes many rows in one transaction;
 * every write is an idempotent UPSERT keyed on the commit SHA.
 */

export type CommitInput = CommitRow;

const upsertStmt = db.prepare(
  `INSERT INTO commits (
     sha, repo_id, author_login, author_email, committed_at, committed_date,
     hour, dow, additions, deletions, files_changed, message
   ) VALUES (
     @sha, @repo_id, @author_login, @author_email, @committed_at,
     @committed_date, @hour, @dow, @additions, @deletions, @files_changed,
     @message
   )
   ON CONFLICT(sha) DO UPDATE SET
     repo_id        = excluded.repo_id,
     author_login   = excluded.author_login,
     author_email   = excluded.author_email,
     committed_at   = excluded.committed_at,
     committed_date = excluded.committed_date,
     hour           = excluded.hour,
     dow            = excluded.dow,
     additions      = excluded.additions,
     deletions      = excluded.deletions,
     files_changed  = excluded.files_changed,
     message        = excluded.message`,
);

const bulkUpsertTxn = db.transaction((rows: CommitInput[]) => {
  for (const row of rows) upsertStmt.run(row);
  return rows.length;
});

const countInRangeStmt = db.prepare<[string, string]>(
  "SELECT COUNT(*) AS n FROM commits WHERE committed_date BETWEEN ? AND ?",
);

const listByRepoRangeStmt = db.prepare<[number, string, string]>(
  `SELECT * FROM commits
   WHERE repo_id = ? AND committed_date BETWEEN ? AND ?
   ORDER BY committed_at ASC`,
);

const distinctDatesStmt = db.prepare<[string, string]>(
  `SELECT DISTINCT committed_date FROM commits
   WHERE committed_date BETWEEN ? AND ?
   ORDER BY committed_date ASC`,
);

/** Upsert many commits in a single transaction. Returns the row count. */
export function bulkUpsertCommits(commits: CommitInput[]): number {
  if (commits.length === 0) return 0;
  return bulkUpsertTxn(commits);
}

/** Count commits whose committed_date falls within the (inclusive) range. */
export function countCommits(range: DateRange): number {
  const row = countInRangeStmt.get(range.from, range.to) as { n: number };
  return row.n;
}

/** List a repo's commits within the (inclusive) range, oldest first. */
export function listCommits(repoId: number, range: DateRange): CommitRow[] {
  return listByRepoRangeStmt.all(repoId, range.from, range.to) as CommitRow[];
}

/** Distinct committed_date values within the range, ascending. */
export function getDistinctCommitDates(range: DateRange): string[] {
  const rows = distinctDatesStmt.all(range.from, range.to) as {
    committed_date: string | null;
  }[];
  return rows.map((r) => r.committed_date).filter((d): d is string => d !== null);
}
