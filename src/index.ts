import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";

import { loadConfig } from "./config.js";
import { tools, toolsByName } from "./tools/index.js";
import { toToolResult, ToolError } from "./utils/errors.js";
import { logger, redactSecret } from "./utils/logger.js";
import { closeDb } from "./db/client.js";
import { overScopedWarning, TokenVerificationError, verifyToken } from "./github/verify.js";
import { firstRunActive, startInitialSyncIfEmpty, stillSyncingResponse } from "./services/bootstrap.js";

declare const __APP_VERSION__: string;

const SERVER_NAME = "github-insights";
const SERVER_VERSION = __APP_VERSION__;

/**
 * Convert a tool's zod input schema into a JSON Schema object suitable for the
 * MCP ListTools response. The MCP spec expects an object-typed schema.
 */
function toInputJsonSchema(tool: (typeof tools)[number]): Record<string, unknown> {
  const schema = zodToJsonSchema(tool.inputSchema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  // The MCP client expects `type: "object"` at the top level; zod objects
  // already produce this, but guard against non-object schemas.
  if (schema.type !== "object") {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  return schema;
}

/** Wrap a handler's return value in the MCP tool-result content envelope. */
function asToolContent(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

async function main(): Promise<void> {
  // Validate configuration up front so misconfiguration fails fast with a
  // readable message before we ever touch the transport.
  const config = loadConfig();
  // Register the token for redaction before any request can log it.
  redactSecret(config.GITHUB_TOKEN);

  // Verify the token by calling /user BEFORE the MCP handshake, so a bad token
  // surfaces as a real reason in the client instead of silent tool failures.
  try {
    const info = await verifyToken();
    logger.info("GitHub token verified", { login: info.login, classic: info.classic });
    const warning = overScopedWarning(info);
    if (warning) logger.warn(warning);
  } catch (err) {
    if (err instanceof TokenVerificationError) {
      const guidance: Record<string, string> = {
        bad_token: "Set a valid GITHUB_TOKEN (a classic PAT with scopes: repo, read:user, read:org).",
        forbidden: "Check the token's scopes and authorize it for your org's SSO if required.",
        network: "Check your internet connection and any proxy/firewall, then retry.",
        unknown: "Retry; if it persists, regenerate the token.",
      };
      process.stderr.write(
        `\n[github-insights] Startup aborted: ${err.message}\n  -> ${guidance[err.kind] ?? ""}\n\n`,
      );
      closeDb();
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // First-run: if the DB is empty, kick off an initial sync in the background.
  // Tools return a friendly "still syncing" response until it finishes.
  startInitialSyncIfEmpty();

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: toInputJsonSchema(tool),
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const tool = toolsByName.get(name);

    if (!tool) {
      // Unknown tool: return a proper MCP error rather than crashing.
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    // While the first-run sync is in flight, don't return misleading empty
    // data — tell the caller we're still setting up.
    if (firstRunActive()) {
      return asToolContent(stillSyncingResponse());
    }

    try {
      const parsed = tool.inputSchema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        throw new ToolError("invalid_input", `Invalid arguments for ${name}: ${detail}`);
      }

      const result = await tool.handler(parsed.data);
      return asToolContent(result);
    } catch (err) {
      // Expected/tool errors are shaped into a structured result and flagged
      // with isError so the client can surface them without a transport fault.
      logger.warn(`Tool "${name}" failed`, { err: String(err) });
      return { ...asToolContent(toToolResult(err)), isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info(`${SERVER_NAME} v${SERVER_VERSION} ready on stdio`, {
    tools: tools.map((t) => t.name),
  });

  // Graceful shutdown: close the transport, checkpoint the WAL and close the DB.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down`);
    try {
      await server.close();
    } catch {
      // ignore
    } finally {
      closeDb();
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Last-resort checkpoint if the process exits for another reason.
  process.on("exit", () => closeDb());
}

main().catch((err) => {
  logger.error("Fatal error during startup", {
    message: err instanceof Error ? err.message : String(err),
  });
  // Print the full readable message to stderr too (config errors are multi-line).
  process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
