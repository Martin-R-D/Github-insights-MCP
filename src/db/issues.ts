import { db } from "./client.js";

/**
 * Issue persistence. Idempotent UPSERT keyed on the issue id. The GitHub issues
 * endpoint also returns PRs; `is_pull_request` distinguishes them.
 */

export interface IssueInput {
  id: number;
  repo_id: number;
  number: number;
  state: string | null;
  title: string | null;
  author_login: string | null;
  created_at: string | null;
  closed_at: string | null;
  is_pull_request: number;
}

const upsertStmt = db.prepare(
  `INSERT INTO issues (
     id, repo_id, number, state, title, author_login, created_at, closed_at,
     is_pull_request
   ) VALUES (
     @id, @repo_id, @number, @state, @title, @author_login, @created_at,
     @closed_at, @is_pull_request
   )
   ON CONFLICT(id) DO UPDATE SET
     repo_id         = excluded.repo_id,
     number          = excluded.number,
     state           = excluded.state,
     title           = excluded.title,
     author_login    = excluded.author_login,
     created_at      = excluded.created_at,
     closed_at       = excluded.closed_at,
     is_pull_request = excluded.is_pull_request`,
);

const bulkUpsertTxn = db.transaction((rows: IssueInput[]) => {
  for (const row of rows) upsertStmt.run(row);
  return rows.length;
});

export function bulkUpsertIssues(rows: IssueInput[]): number {
  if (rows.length === 0) return 0;
  return bulkUpsertTxn(rows);
}
