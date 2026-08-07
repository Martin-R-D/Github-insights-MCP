import { db } from "./client.js";
import type { DailySnapshotRow, DateRange } from "./types.js";

/**
 * Daily snapshot persistence. Idempotent UPSERT keyed on (date, repo_id) so
 * re-running a day's snapshot overwrites rather than duplicates.
 */

export type DailySnapshotInput = DailySnapshotRow;

const upsertStmt = db.prepare(
  `INSERT INTO daily_snapshots (date, repo_id, stars, forks, open_issues, commits_count)
   VALUES (@date, @repo_id, @stars, @forks, @open_issues, @commits_count)
   ON CONFLICT(date, repo_id) DO UPDATE SET
     stars         = excluded.stars,
     forks         = excluded.forks,
     open_issues   = excluded.open_issues,
     commits_count = excluded.commits_count`,
);

const getInRangeStmt = db.prepare<[number, string, string]>(
  `SELECT * FROM daily_snapshots
   WHERE repo_id = ? AND date BETWEEN ? AND ?
   ORDER BY date ASC`,
);

/** Insert or update one repo's snapshot for a given date. */
export function writeDailySnapshot(snapshot: DailySnapshotInput): void {
  upsertStmt.run(snapshot);
}

/** Get a repo's snapshots within the (inclusive) date range, ascending. */
export function getSnapshots(repoId: number, range: DateRange): DailySnapshotRow[] {
  return getInRangeStmt.all(repoId, range.from, range.to) as DailySnapshotRow[];
}
