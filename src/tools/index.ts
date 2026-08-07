import type { ToolDefinition } from "./types.js";
import { pingTool } from "./ping.js";
import { syncGithubDataTool } from "./sync_github_data.js";
import { getAllReposTool } from "./get_all_repos.js";
import { getCommitActivityTool } from "./get_commit_activity.js";

/**
 * The tool registry. Add new tools to this array; `src/index.ts` builds the
 * ListTools response and the CallTool dispatch table from it.
 */
export const tools: ToolDefinition[] = [
  pingTool,
  syncGithubDataTool,
  getAllReposTool,
  getCommitActivityTool,
];

/** Lookup map by tool name for O(1) dispatch. */
export const toolsByName: ReadonlyMap<string, ToolDefinition> = new Map(
  tools.map((tool) => [tool.name, tool]),
);

export type { ToolDefinition } from "./types.js";
