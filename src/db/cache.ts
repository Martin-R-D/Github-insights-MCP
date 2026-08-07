import { createHash } from "node:crypto";
import { db } from "./client.js";
import type { HttpCacheRow } from "./types.js";

/**
 * HTTP response cache (for conditional GitHub requests). Keyed on a hash of the
 * URL. Idempotent UPSERT so re-caching a URL overwrites its entry.
 */

export interface CacheEntryInput {
  url: string;
  etag?: string | null;
  last_modified?: string | null;
  body?: string | null;
  fetched_at?: string | null;
  expires_at?: string | null;
}

function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

const getStmt = db.prepare<[string]>(
  "SELECT * FROM http_cache WHERE url_hash = ?",
);

const putStmt = db.prepare(
  `INSERT INTO http_cache (
     url_hash, url, etag, last_modified, body, fetched_at, expires_at
   ) VALUES (
     @url_hash, @url, @etag, @last_modified, @body, @fetched_at, @expires_at
   )
   ON CONFLICT(url_hash) DO UPDATE SET
     url           = excluded.url,
     etag          = excluded.etag,
     last_modified = excluded.last_modified,
     body          = excluded.body,
     fetched_at    = excluded.fetched_at,
     expires_at    = excluded.expires_at`,
);

const purgeStmt = db.prepare<[string]>(
  "DELETE FROM http_cache WHERE expires_at IS NOT NULL AND expires_at < ?",
);

/** Look up a cached response by URL. */
export function getCached(url: string): HttpCacheRow | undefined {
  return getStmt.get(hashUrl(url)) as HttpCacheRow | undefined;
}

/** Insert or update a cache entry for a URL. */
export function putCached(entry: CacheEntryInput): void {
  putStmt.run({
    url_hash: hashUrl(entry.url),
    url: entry.url,
    etag: entry.etag ?? null,
    last_modified: entry.last_modified ?? null,
    body: entry.body ?? null,
    fetched_at: entry.fetched_at ?? new Date().toISOString(),
    expires_at: entry.expires_at ?? null,
  });
}

/**
 * Delete entries whose expires_at is in the past. Returns the number of rows
 * removed. `now` defaults to the current time (ISO string).
 */
export function purgeExpired(now: string = new Date().toISOString()): number {
  const info = purgeStmt.run(now);
  return info.changes;
}
