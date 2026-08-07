import { db } from "./client.js";

/**
 * Pull request persistence. Idempotent UPSERT keyed on the PR id.
 */

export interface PullRequestInput {
  id: number;
  repo_id: number;
  number: number;
  state: string | null;
  title: string | null;
  author_login: string | null;
  created_at: string | null;
  merged_at: string | null;
  closed_at: string | null;
  additions: number | null;
  deletions: number | null;
}

const upsertStmt = db.prepare(
  `INSERT INTO pull_requests (
     id, repo_id, number, state, title, author_login, created_at, merged_at,
     closed_at, additions, deletions
   ) VALUES (
     @id, @repo_id, @number, @state, @title, @author_login, @created_at,
     @merged_at, @closed_at, @additions, @deletions
   )
   ON CONFLICT(id) DO UPDATE SET
     repo_id      = excluded.repo_id,
     number       = excluded.number,
     state        = excluded.state,
     title        = excluded.title,
     author_login = excluded.author_login,
     created_at   = excluded.created_at,
     merged_at    = excluded.merged_at,
     closed_at    = excluded.closed_at,
     additions    = excluded.additions,
     deletions    = excluded.deletions`,
);

const bulkUpsertTxn = db.transaction((rows: PullRequestInput[]) => {
  for (const row of rows) upsertStmt.run(row);
  return rows.length;
});

export function bulkUpsertPullRequests(rows: PullRequestInput[]): number {
  if (rows.length === 0) return 0;
  return bulkUpsertTxn(rows);
}
