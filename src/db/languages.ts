import { db } from "./client.js";

/**
 * Per-repo language byte counts. Idempotent UPSERT keyed on (repo_id, language).
 */

const upsertStmt = db.prepare(
  `INSERT INTO repo_languages (repo_id, language, bytes, synced_at)
   VALUES (@repo_id, @language, @bytes, @synced_at)
   ON CONFLICT(repo_id, language) DO UPDATE SET
     bytes     = excluded.bytes,
     synced_at = excluded.synced_at`,
);

const bulkUpsertTxn = db.transaction(
  (repoId: number, langs: Record<string, number>, syncedAt: string) => {
    let n = 0;
    for (const [language, bytes] of Object.entries(langs)) {
      upsertStmt.run({ repo_id: repoId, language, bytes, synced_at: syncedAt });
      n += 1;
    }
    return n;
  },
);

/** Replace/refresh a repo's language byte counts. Returns rows written. */
export function bulkUpsertLanguages(
  repoId: number,
  langs: Record<string, number>,
  syncedAt: string = new Date().toISOString(),
): number {
  return bulkUpsertTxn(repoId, langs, syncedAt);
}
