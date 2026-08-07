import { db } from "./client.js";
import type { StargazerRow } from "./types.js";

/**
 * Stargazer persistence. Idempotent UPSERT keyed on (repo_id, user_login).
 */

export type StargazerInput = StargazerRow;

const upsertStmt = db.prepare(
  `INSERT INTO stargazers (repo_id, user_login, starred_at)
   VALUES (@repo_id, @user_login, @starred_at)
   ON CONFLICT(repo_id, user_login) DO UPDATE SET
     starred_at = excluded.starred_at`,
);

const bulkUpsertTxn = db.transaction((rows: StargazerInput[]) => {
  for (const row of rows) upsertStmt.run(row);
  return rows.length;
});

const listSinceStmt = db.prepare<[string]>(
  `SELECT * FROM stargazers
   WHERE starred_at >= ?
   ORDER BY starred_at ASC`,
);

/** Upsert many stargazers in one transaction. Returns the row count. */
export function bulkUpsertStargazers(stargazers: StargazerInput[]): number {
  if (stargazers.length === 0) return 0;
  return bulkUpsertTxn(stargazers);
}

/** List stargazers starred on or after `date` (inclusive), oldest first. */
export function listStarsSince(date: string): StargazerRow[] {
  return listSinceStmt.all(date) as StargazerRow[];
}
