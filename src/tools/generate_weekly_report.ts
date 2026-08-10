import { z } from "zod";
import { defineTool } from "./types.js";
import { generateWeeklyReport } from "../services/report.js";

/**
 * MCP tool: generate a weekly activity report. Fans out over a fresh sync and
 * every report section (see services/report.ts). Degrades gracefully — a failing
 * section is nulled and listed in meta.partial_failures.
 */
export const generateWeeklyReportTool = defineTool({
  name: "generate_weekly_report",
  description:
    "Generate a weekly activity report (Mon-Sun in your timezone): headline metrics, week-over-week " +
    "deltas, per-repo work, what shipped, patterns, community and items needing attention. " +
    "format='markdown' adds a ready-to-paste report.",
  inputSchema: z
    .object({
      week_offset: z.number().int().min(0).max(520).default(0),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      compare: z.boolean().default(true),
      format: z.enum(["structured", "markdown"]).default("structured"),
    })
    .strict(),
  handler: async (args) => {
    return generateWeeklyReport(args);
  },
});
