import type { ToolDefinition } from "./types.js";
import { pingTool } from "./ping.js";
import { syncGithubDataTool } from "./sync_github_data.js";
import { getAllReposTool } from "./get_all_repos.js";
import { getCommitActivityTool } from "./get_commit_activity.js";
import { getCommitPatternsTool } from "./get_commit_patterns.js";
import { getRepoStatsTool } from "./get_repo_stats.js";
import { getStarsReceivedTool } from "./get_stars_received.js";
import { getLanguageBreakdownTool } from "./get_language_breakdown.js";
import { getContributionSummaryTool } from "./get_contribution_summary.js";
import { compareReposTool } from "./compare_repos.js";
import { getOpenItemsTool } from "./get_open_items.js";
import { generateWeeklyReportTool } from "./generate_weekly_report.js";

/**
 * The tool registry. Add new tools to this array; `src/index.ts` builds the
 * ListTools response and the CallTool dispatch table from it.
 */
export const tools: ToolDefinition[] = [
  pingTool,
  syncGithubDataTool,
  getAllReposTool,
  getCommitActivityTool,
  getCommitPatternsTool,
  getRepoStatsTool,
  getStarsReceivedTool,
  getLanguageBreakdownTool,
  getContributionSummaryTool,
  compareReposTool,
  getOpenItemsTool,
  generateWeeklyReportTool,
];

/** Lookup map by tool name for O(1) dispatch. */
export const toolsByName: ReadonlyMap<string, ToolDefinition> = new Map(
  tools.map((tool) => [tool.name, tool]),
);

export type { ToolDefinition } from "./types.js";
