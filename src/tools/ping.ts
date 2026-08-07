import { z } from "zod";
import { defineTool } from "./types.js";

/**
 * Minimal placeholder tool used to verify the MCP handshake and dispatch path
 * end to end. Takes no meaningful input and echoes a fixed summary.
 */
export const pingTool = defineTool({
  name: "ping",
  description:
    "Health check. Returns { summary: \"pong\" } to confirm the server is reachable and dispatch works.",
  inputSchema: z.object({}).strict(),
  handler: () => {
    return { summary: "pong" };
  },
});
