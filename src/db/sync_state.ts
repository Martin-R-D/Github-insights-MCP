import { db } from "./client.js";

/**
 * Bookkeeping for incremental syncs. One row per resource (e.g.
 * "commits:123"), recording the last cursor / timestamp / etag so the next
 * sync can resume rather than refetch everything.
 */

export interface SyncStateRow {
  resource: string;
  repo_id: number | null;
  last_cursor: string | null;
  last_synced_at: string | null;
  etag: string | null;
}

const getStmt = db.prepare<[string]>("SELECT * FROM sync_state WHERE resource = ?");

const upsertStmt = db.prepare(
  `INSERT INTO sync_state (resource, repo_id, last_cursor, last_synced_at, etag)
   VALUES (@resource, @repo_id, @last_cursor, @last_synced_at, @etag)
   ON CONFLICT(resource) DO UPDATE SET
     repo_id        = excluded.repo_id,
     last_cursor    = excluded.last_cursor,
     last_synced_at = excluded.last_synced_at,
     etag           = excluded.etag`,
);

export function getSyncState(resource: string): SyncStateRow | undefined {
  return getStmt.get(resource) as SyncStateRow | undefined;
}

export function upsertSyncState(state: {
  resource: string;
  repo_id?: number | null;
  last_cursor?: string | null;
  last_synced_at?: string | null;
  etag?: string | null;
}): void {
  upsertStmt.run({
    resource: state.resource,
    repo_id: state.repo_id ?? null,
    last_cursor: state.last_cursor ?? null,
    last_synced_at: state.last_synced_at ?? null,
    etag: state.etag ?? null,
  });
}
