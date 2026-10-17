import { createHash } from "node:crypto";
import { Octokit } from "@octokit/rest";
import { loadConfig } from "../config.js";
import { getCached, putCached } from "../db/cache.js";
import { ToolError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/**
 * GitHub REST client with:
 *  - on-disk conditional caching (ETag / If-None-Match) backed by http_cache,
 *  - a rate-limit tracker fed from every response, with a stale-serve / bail
 *    policy when the remaining budget runs low,
 *  - exponential backoff with jitter for transient 5xx and secondary rate
 *    limits (never for 401/404),
 *  - Link-header pagination that caches each page independently.
 */

declare const __APP_VERSION__: string;
const USER_AGENT = `github-insights-mcp/${__APP_VERSION__}`;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 20_000;
/** Below this many remaining core requests we stop firing and serve stale. */
const RATE_LIMIT_FLOOR = 100;

export interface RateLimitState {
  /** Requests remaining in the current window, or null if unknown yet. */
  remaining: number | null;
  /** Unix seconds when the window resets, or null if unknown. */
  reset: number | null;
  /** Total limit for the window, or null if unknown. */
  limit: number | null;
}

export interface CachedResult<T> {
  data: T;
  /** Served from a still-fresh cache row without any network call. */
  fromCache?: boolean;
  /** Served from cache because the rate-limit floor was hit. */
  stale?: boolean;
  /** Revalidated over the network and confirmed unchanged (304). */
  notModified?: boolean;
  status?: number;
  headers?: Record<string, string>;
  etag?: string | null;
}

export interface RequestOptions {
  ttlSeconds: number;
}

export interface PaginateOptions extends RequestOptions {
  maxPages?: number;
}

type AnyParams = Record<string, unknown>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function isFuture(iso: string | null | undefined): boolean {
  return !!iso && Date.parse(iso) > Date.now();
}

/** Stable cache key from route + params, ignoring conditional headers. */
function cacheKey(route: string, params: AnyParams): string {
  const clone: AnyParams = { ...params };
  if (clone.headers && typeof clone.headers === "object") {
    const headers = { ...(clone.headers as AnyParams) };
    delete headers["if-none-match"];
    delete headers["If-None-Match"];
    delete headers["if-modified-since"];
    clone.headers = headers;
  }
  const stable = JSON.stringify(clone, Object.keys(clone).sort());
  const hash = createHash("sha256").update(`${route}\n${stable}`).digest("hex");
  return `${route}#${hash}`;
}

function parseRetryAfter(headers: Record<string, string> | undefined): number | null {
  const raw = headers?.["retry-after"];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

function backoffDelay(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs != null) return Math.min(retryAfterMs, MAX_BACKOFF_MS);
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  // Full jitter.
  return Math.floor(Math.random() * exp);
}

/** Is this a 403 that represents a secondary (abuse) rate limit? */
function isSecondaryRateLimit(status: number, headers: Record<string, string> | undefined, message: string): boolean {
  if (status !== 403) return false;
  if (headers?.["retry-after"]) return true;
  return /secondary rate limit/i.test(message);
}

export interface GithubClientOptions {
  token?: string;
  userAgent?: string;
  /** Override the underlying fetch (used by tests so nock can intercept). */
  fetch?: typeof fetch;
  octokit?: Octokit;
}

export interface GithubClient {
  octokit: Octokit;
  getRateLimit(): RateLimitState;
  cachedRequest<T>(route: string, params: AnyParams, opts: RequestOptions): Promise<CachedResult<T>>;
  paginateAll<T>(route: string, params: AnyParams, opts: PaginateOptions): Promise<T[]>;
}

export function createGithubClient(options: GithubClientOptions = {}): GithubClient {
  const token = options.token ?? loadConfig().GITHUB_TOKEN;

  const octokit =
    options.octokit ??
    new Octokit({
      auth: token,
      userAgent: options.userAgent ?? USER_AGENT,
      ...(options.fetch ? { request: { fetch: options.fetch } } : {}),
    });

  const rateLimit: RateLimitState = { remaining: null, reset: null, limit: null };

  function recordRateLimit(headers: Record<string, string> | undefined): void {
    if (!headers) return;
    const remaining = headers["x-ratelimit-remaining"];
    const reset = headers["x-ratelimit-reset"];
    const limit = headers["x-ratelimit-limit"];
    if (remaining !== undefined) rateLimit.remaining = Number(remaining);
    if (reset !== undefined) rateLimit.reset = Number(reset);
    if (limit !== undefined) rateLimit.limit = Number(limit);
  }

  // Request hook: capture rate-limit headers from successes and errors alike.
  octokit.hook.after("request", (response) => {
    recordRateLimit(response.headers as Record<string, string>);
  });
  octokit.hook.error("request", (error) => {
    const err = error as { response?: { headers?: Record<string, string> } };
    recordRateLimit(err.response?.headers);
    throw error;
  });

  interface RawResponse {
    status: number;
    headers: Record<string, string>;
    data: unknown;
  }

  async function requestWithRetry(route: string, params: AnyParams, attempt = 0): Promise<RawResponse> {
    try {
      const res = await octokit.request(route, params);
      return { status: res.status, headers: res.headers as Record<string, string>, data: res.data };
    } catch (error) {
      const err = error as {
        status?: number;
        message?: string;
        response?: { headers?: Record<string, string>; data?: unknown };
      };
      const status = err.status ?? 0;
      const headers = err.response?.headers;

      // 304 Not Modified is surfaced by Octokit as an error; treat it as a
      // (bodyless) successful revalidation.
      if (status === 304) {
        return { status: 304, headers: headers ?? {}, data: err.response?.data };
      }

      // Never retry auth / not-found.
      if (status === 401 || status === 404) throw error;

      const retryable =
        status === 500 ||
        status === 502 ||
        status === 503 ||
        isSecondaryRateLimit(status, headers, err.message ?? "");

      if (retryable && attempt < MAX_RETRIES) {
        const delay = backoffDelay(attempt, parseRetryAfter(headers));
        logger.warn("Retrying GitHub request", { route, status, attempt: attempt + 1, delay });
        await sleep(delay);
        return requestWithRetry(route, params, attempt + 1);
      }

      throw error;
    }
  }

  async function cachedRequest<T>(route: string, params: AnyParams, opts: RequestOptions): Promise<CachedResult<T>> {
    const key = cacheKey(route, params);
    const cached = getCached(key);

    // 1. Fresh cache hit — no network.
    if (cached?.body && isFuture(cached.expires_at)) {
      return { data: JSON.parse(cached.body) as T, fromCache: true };
    }

    // 2. Rate-limit floor: don't fire; serve stale if we have it, else bail.
    if (rateLimit.remaining !== null && rateLimit.remaining < RATE_LIMIT_FLOOR) {
      if (cached?.body) {
        return { data: JSON.parse(cached.body) as T, stale: true };
      }
      const resetIso = rateLimit.reset ? new Date(rateLimit.reset * 1000).toISOString() : "unknown";
      throw new ToolError(
        "rate_limited",
        "GitHub API rate limit is nearly exhausted; refusing to make new requests.",
        `Rate limit resets at ${resetIso}. Try again after that time.`,
      );
    }

    // 3. Conditional request with the stored ETag.
    const headers: Record<string, string> = { ...(params.headers as Record<string, string> | undefined) };
    if (cached?.etag) headers["if-none-match"] = cached.etag;
    const res = await requestWithRetry(route, { ...params, headers });

    const expiresAt = new Date(Date.now() + opts.ttlSeconds * 1000).toISOString();

    // 3a. Not modified — refresh TTL, return cached body.
    if (res.status === 304 && cached?.body) {
      putCached({
        url: key,
        etag: cached.etag,
        last_modified: cached.last_modified,
        body: cached.body,
        fetched_at: nowIso(),
        expires_at: expiresAt,
      });
      return { data: JSON.parse(cached.body) as T, fromCache: true, notModified: true, status: 304 };
    }

    // 3b. Fresh 200 — store body + ETag.
    const body = JSON.stringify(res.data);
    putCached({
      url: key,
      etag: res.headers["etag"] ?? null,
      last_modified: res.headers["last-modified"] ?? null,
      body,
      fetched_at: nowIso(),
      expires_at: expiresAt,
    });

    return {
      data: res.data as T,
      status: res.status,
      headers: res.headers,
      etag: res.headers["etag"] ?? null,
    };
  }

  async function paginateAll<T>(route: string, params: AnyParams, opts: PaginateOptions): Promise<T[]> {
    const perPage = typeof params.per_page === "number" ? params.per_page : 100;
    const maxPages = opts.maxPages ?? Infinity;
    const out: T[] = [];

    let page = typeof params.page === "number" ? params.page : 1;
    let fetched = 0;

    while (fetched < maxPages) {
      const res = await cachedRequest<T[]>(route, { ...params, per_page: perPage, page }, opts);
      const items = Array.isArray(res.data) ? res.data : [];
      out.push(...items);
      fetched += 1;

      // Prefer the Link header (present on live responses); fall back to a
      // page-size heuristic when the page was served from cache (no headers).
      const link = res.headers?.["link"];
      const hasNext = link ? /rel="next"/.test(link) : items.length === perPage && items.length > 0;
      if (!hasNext) break;
      page += 1;
    }

    return out;
  }

  return {
    octokit,
    getRateLimit: () => ({ ...rateLimit }),
    cachedRequest,
    paginateAll,
  };
}

// Lazily-created default singleton so importing this module doesn't force
// config validation (and a token) until the client is actually used.
let singleton: GithubClient | undefined;

export function getGithubClient(): GithubClient {
  if (!singleton) singleton = createGithubClient();
  return singleton;
}

/** Convenience accessor for the default client's rate-limit state. */
export function getRateLimit(): RateLimitState {
  return getGithubClient().getRateLimit();
}
