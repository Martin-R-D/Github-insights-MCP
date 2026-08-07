import type { ToolDefinition } from "./types.js";
import { pingTool } from "./ping.js";

/**
 * The tool registry. Add new tools to this array; `src/index.ts` builds the
 * ListTools response and the CallTool dispatch table from it.
 */
export const tools: ToolDefinition[] = [pingTool];

/** Lookup map by tool name for O(1) dispatch. */
export const toolsByName: ReadonlyMap<string, ToolDefinition> = new Map(
  tools.map((tool) => [tool.name, tool]),
);

export type { ToolDefinition } from "./types.js";
