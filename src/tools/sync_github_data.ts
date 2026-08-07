import { z } from "zod";
import { defineTool } from "./types.js";
import { syncAll } from "../services/sync.js";

/**
 * MCP tool: pull GitHub data into the local store. Thin wrapper over syncAll.
 */
export const syncGithubDataTool = defineTool({
  name: "sync_github_data",
  description:
    "Sync GitHub data (repos, commits, stars, languages, PRs/issues) into the local cache. " +
    "Use full=true for a 365-day backfill with commit enrichment; omit for an incremental update. " +
    "Optionally limit to a single repo.",
  inputSchema: z
    .object({
      full: z.boolean().optional().describe("Full backfill (365 days) instead of incremental."),
      repo: z.string().optional().describe("Limit to one repo by full_name (owner/name) or bare name."),
    })
    .strict(),
  handler: async ({ full, repo }) => {
    const report = await syncAll({ full: full ?? false, repo });

    const errorNote = report.errors.length ? `, ${report.errors.length} error(s)` : "";
    const summary =
      `Synced ${report.reposSynced} repo(s): +${report.commitsAdded} commits, ` +
      `+${report.starsAdded} stars in ${report.durationMs}ms${errorNote}.`;

    return {
      summary,
      data: report,
      meta: {
        durationMs: report.durationMs,
        rateLimitRemaining: report.rateLimitRemaining,
        errorCount: report.errors.length,
      },
    };
  },
});
