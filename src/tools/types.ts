import type { z } from "zod";

/**
 * A registered MCP tool. `inputSchema` is a zod object that both validates
 * arguments at call time and is converted to JSON Schema for the ListTools
 * response. The handler receives already-parsed, typed arguments.
 */
export interface ToolDefinition<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: Schema;
  handler: (args: z.infer<Schema>) => Promise<unknown> | unknown;
}

/**
 * Helper to define a tool with full type inference between `inputSchema` and
 * the `handler` argument, without widening to `any`.
 */
export function defineTool<Schema extends z.ZodTypeAny>(
  def: ToolDefinition<Schema>,
): ToolDefinition {
  return def as unknown as ToolDefinition;
}
