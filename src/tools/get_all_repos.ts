import { z } from "zod";
import { defineTool } from "./types.js";
import { listRepos } from "../db/repos.js";
import { syncRepos } from "../services/sync.js";
import type { RepoRow } from "../db/types.js";

/**
 * MCP tool: list all repos from the local store, syncing first if the cache is
 * stale (> 15 min). Never reads the GitHub API directly here — it reads SQLite
 * and lets syncRepos() do any network work.
 */

const FRESH_MS = 15 * 60 * 1000;
const DAY_MS = 86_400_000;

const sortEnum = z.enum(["stars", "updated", "created", "size", "name"]);

const inputSchema = z
  .object({
    include_forks: z.boolean().default(false),
    include_archived: z.boolean().default(false),
    include_private: z.boolean().default(true),
    sort: sortEnum.default("updated"),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

function nullableDateDesc(a: string | null, b: string | null): number {
  // Newest first; nulls sort last.
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? 1 : -1;
}

function sortRepos(repos: RepoRow[], sort: Input["sort"]): RepoRow[] {
  const copy = [...repos];
  switch (sort) {
    case "stars":
      return copy.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
    case "size":
      return copy.sort((a, b) => (b.size_kb ?? 0) - (a.size_kb ?? 0));
    case "created":
      return copy.sort((a, b) => nullableDateDesc(a.created_at, b.created_at));
    case "name":
      return copy.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", undefined, { sensitivity: "base" }));
    case "updated":
    default:
      return copy.sort((a, b) => nullableDateDesc(a.updated_at, b.updated_at));
  }
}

function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / DAY_MS);
}

function humanizeDays(days: number | null): string {
  if (days === null) return "unknown";
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

/** True if any repo was synced within the freshness window. */
function cacheIsFresh(now: number): boolean {
  const all = listRepos({ includeForks: true, includeArchived: true, includePrivate: true });
  let latest = 0;
  for (const r of all) {
    if (r.synced_at) {
      const t = Date.parse(r.synced_at);
      if (!Number.isNaN(t) && t > latest) latest = t;
    }
  }
  return latest > 0 && now - latest <= FRESH_MS;
}

export const getAllReposTool = defineTool({
  name: "get_all_repos",
  description:
    "List your repositories from the local cache (syncing first if stale), with totals. " +
    "Filter forks/archived/private and sort by stars, updated, created, size, or name.",
  inputSchema,
  handler: async (args: Input) => {
    const fresh = cacheIsFresh(Date.now());
    if (!fresh) {
      // Refresh from the API into SQLite, then read locally.
      await syncRepos();
    }

    const now = Date.now();
    const filtered = listRepos({
      includeForks: args.include_forks,
      includeArchived: args.include_archived,
      includePrivate: args.include_private,
    });

    const totals = filtered.reduce(
      (acc, r) => {
        acc.stars += r.stars ?? 0;
        acc.forks += r.forks ?? 0;
        acc.open_issues += r.open_issues ?? 0;
        if (r.fork) acc.forkCount += 1;
        else acc.sourceCount += 1;
        return acc;
      },
      { stars: 0, forks: 0, open_issues: 0, forkCount: 0, sourceCount: 0 },
    );

    const limited = sortRepos(filtered, args.sort).slice(0, args.limit);

    const repos = limited.map((r) => ({
      name: r.name,
      full_name: r.full_name,
      description: r.description,
      stars: r.stars ?? 0,
      forks: r.forks ?? 0,
      open_issues: r.open_issues ?? 0,
      primary_language: r.primary_language,
      size_kb: r.size_kb ?? 0,
      private: Boolean(r.private),
      fork: Boolean(r.fork),
      archived: Boolean(r.archived),
      created_at: r.created_at,
      pushed_at: r.pushed_at,
      days_since_push: daysSince(r.pushed_at, now),
    }));

    // Most recently pushed across the filtered set (for the summary line).
    let mostRecent: RepoRow | undefined;
    for (const r of filtered) {
      if (!r.pushed_at) continue;
      if (!mostRecent || nullableDateDesc(r.pushed_at, mostRecent.pushed_at) < 0) mostRecent = r;
    }

    const summaryHead =
      `You have ${filtered.length} repos ` +
      `(${totals.sourceCount} sources, ${totals.forkCount} forks) ` +
      `with ${totals.stars} total stars.`;
    const summaryTail = mostRecent
      ? ` Most recently pushed: ${mostRecent.name} (${humanizeDays(daysSince(mostRecent.pushed_at, now))}).`
      : "";

    return {
      summary: summaryHead + summaryTail,
      data: {
        total_repos: filtered.length,
        total_stars: totals.stars,
        total_forks: totals.forks,
        total_open_issues: totals.open_issues,
        repos,
      },
      meta: {
        from_cache: fresh,
        stale: false,
        generated_at: new Date().toISOString(),
        repos_covered: filtered.length,
      },
    };
  },
});
