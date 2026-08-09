import { z } from "zod";
import { defineTool } from "./types.js";
import { db } from "../db/client.js";
import { listRepos } from "../db/repos.js";
import { getSyncState } from "../db/sync_state.js";
import { syncLanguages } from "../services/sync.js";
import { pct } from "./_shared.js";

/**
 * MCP tool: language breakdown across repos.
 *
 * IMPORTANT CAVEAT (surfaced in the data so the model can hedge): GitHub reports
 * language *bytes*, not lines or effort. Verbose/markup-heavy languages (HTML,
 * CSS, JSON) inflate a byte-based percentage. We always return repo_count next
 * to percent so the share can be caveated. We deliberately do NOT compute a
 * "total lines of code". When estimate_lines is set we add a *rough* per-language
 * estimate (bytes / avg-bytes-per-line) and flag it in meta.note as an estimate.
 */

const LANG_STALE_MS = 24 * 60 * 60 * 1000;

// Rough average bytes-per-line by language (only used for the opt-in estimate).
const BYTES_PER_LINE: Record<string, number> = {
  TypeScript: 30,
  JavaScript: 30,
  Python: 28,
  Go: 28,
  Java: 32,
  "C++": 30,
  C: 30,
  "C#": 32,
  Ruby: 25,
  Rust: 32,
  PHP: 28,
  Swift: 30,
  Kotlin: 30,
  Shell: 22,
  HTML: 40,
  CSS: 28,
  SCSS: 28,
  JSON: 40,
  YAML: 30,
  Markdown: 45,
};
const DEFAULT_BYTES_PER_LINE = 30;

const inputSchema = z
  .object({
    include_forks: z.boolean().default(false),
    include_archived: z.boolean().default(false),
    weight_by: z.enum(["bytes", "repos", "stars"]).default("bytes"),
    top_n: z.number().int().min(1).max(200).default(15),
    estimate_lines: z.boolean().default(false),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

interface LangJoin {
  repo_id: number;
  repo: string;
  language: string;
  bytes: number;
  stars: number;
  synced_at: string | null;
}

export const getLanguageBreakdownTool = defineTool({
  name: "get_language_breakdown",
  description:
    "Language breakdown across your repos, weighted by bytes, repo count, or stars. Includes a " +
    "polyglot score. Note: GitHub reports bytes, so verbose languages look larger — repo_count is " +
    "provided to caveat this.",
  inputSchema,
  handler: async (args: Input) => {
    const repos = listRepos({
      includeForks: args.include_forks,
      includeArchived: args.include_archived,
      includePrivate: true,
    });

    // Sync languages for repos with missing or >24h-old language data.
    let syncedAny = false;
    const langAge = new Map<number, string | null>(
      (db.prepare("SELECT repo_id, MAX(synced_at) AS s FROM repo_languages GROUP BY repo_id").all() as {
        repo_id: number;
        s: string | null;
      }[]).map((r) => [r.repo_id, r.s]),
    );
    const now = Date.now();
    for (const r of repos) {
      const last = langAge.get(r.id) ?? getSyncState(`languages:${r.id}`)?.last_synced_at ?? null;
      const stale = !last || now - Date.parse(last) > LANG_STALE_MS;
      if (stale) {
        try {
          await syncLanguages(r.id);
          syncedAny = true;
        } catch {
          // Non-fatal.
        }
      }
    }

    const repoIds = repos.map((r) => r.id);
    const rows: LangJoin[] =
      repoIds.length === 0
        ? []
        : (db
            .prepare(
              `SELECT l.repo_id AS repo_id,
                      COALESCE(r.full_name, r.name, 'unknown') AS repo,
                      l.language AS language,
                      l.bytes AS bytes,
                      COALESCE(r.stars, 0) AS stars,
                      l.synced_at AS synced_at
               FROM repo_languages l JOIN repos r ON r.id = l.repo_id
               WHERE l.repo_id IN (${repoIds.map(() => "?").join(",")})`,
            )
            .all(...repoIds) as LangJoin[]);

    // Aggregate per language.
    interface Agg {
      bytes: number;
      repos: Set<number>;
      repoNames: string[];
      stars: number;
      weight: number;
    }
    const byLang = new Map<string, Agg>();
    const reposWithData = new Set<number>();
    for (const row of rows) {
      reposWithData.add(row.repo_id);
      let a = byLang.get(row.language);
      if (!a) {
        a = { bytes: 0, repos: new Set(), repoNames: [], stars: 0, weight: 0 };
        byLang.set(row.language, a);
      }
      a.bytes += row.bytes ?? 0;
      if (!a.repos.has(row.repo_id)) {
        a.repos.add(row.repo_id);
        a.repoNames.push(row.repo);
        a.stars += row.stars ?? 0; // count each repo's stars once per language
      }
    }
    // Weight per selected dimension.
    for (const a of byLang.values()) {
      a.weight = args.weight_by === "repos" ? a.repos.size : args.weight_by === "stars" ? a.stars : a.bytes;
    }

    const totalWeight = [...byLang.values()].reduce((s, a) => s + a.weight, 0);
    const totalBytes = [...byLang.values()].reduce((s, a) => s + a.bytes, 0);

    const sorted = [...byLang.entries()]
      .map(([language, a]) => ({
        language,
        bytes: a.bytes,
        percent: pct(a.weight, totalWeight),
        repo_count: a.repos.size,
        repos: a.repoNames.sort(),
        stars_in_language: a.stars,
        ...(args.estimate_lines
          ? { estimated_lines: Math.round(a.bytes / (BYTES_PER_LINE[language] ?? DEFAULT_BYTES_PER_LINE)) }
          : {}),
      }))
      .sort((x, y) => y.percent - x.percent || y.bytes - x.bytes);

    const top = sorted.slice(0, args.top_n);
    const tail = sorted.slice(args.top_n);
    const other = {
      languages_count: tail.length,
      percent: Math.round(tail.reduce((s, l) => s + l.percent, 0) * 10) / 10,
    };

    // Polyglot score: normalized Shannon entropy over the weight distribution.
    let entropy = 0;
    if (totalWeight > 0) {
      for (const a of byLang.values()) {
        if (a.weight <= 0) continue;
        const p = a.weight / totalWeight;
        entropy -= p * Math.log(p);
      }
    }
    const distinct = byLang.size;
    const polyglot = distinct > 1 ? Math.round((entropy / Math.log(distinct)) * 100) / 100 : 0;

    const primary = top[0]?.language ?? null;

    // Summary: top 3 with repo counts.
    const parts = top.slice(0, 3).map((l, i) => `${l.language} ${l.percent}% (${l.repo_count}${i === 0 ? " repos" : ""})`);
    const summary =
      reposWithData.size === 0
        ? "No language data available yet — run a sync first."
        : `Across ${reposWithData.size} repos: ${parts.join(", ")}. ` +
          `Polyglot score ${polyglot} — you spread across ${distinct} languages.`;

    return {
      summary,
      data: {
        total_bytes: totalBytes,
        repos_analyzed: reposWithData.size,
        distinct_languages: distinct,
        languages: top,
        primary_language: primary,
        polyglot_score: polyglot,
        other,
      },
      meta: {
        from_cache: !syncedAny,
        stale: false,
        generated_at: new Date().toISOString(),
        repos_covered: reposWithData.size,
        ...(args.estimate_lines
          ? { note: "estimated_lines is a rough bytes/avg-line-length estimate, not a real line count." }
          : {}),
      },
    };
  },
});
