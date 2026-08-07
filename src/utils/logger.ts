/**
 * Logger that writes to stderr ONLY.
 *
 * The MCP stdio transport uses stdout to exchange JSON-RPC messages. Anything
 * written to stdout that is not a valid protocol frame corrupts the stream and
 * breaks the client connection. Therefore every diagnostic line here goes to
 * stderr via process.stderr.write — never console.log.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function isLogLevel(value: string): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

// Read the threshold directly from the environment so the logger is usable
// before (and independently of) config validation. Defaults to "info".
function currentThreshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  const level = isLogLevel(raw) ? raw : "info";
  return LEVEL_WEIGHT[level];
}

function write(level: LogLevel, message: string, meta?: unknown): void {
  if (LEVEL_WEIGHT[level] < currentThreshold()) return;

  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: message,
  };
  if (meta !== undefined) record.meta = meta;

  // Serialize defensively: a circular or unserializable meta must never throw
  // and take the server down.
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({ ts: record.ts, level, msg: message, meta: String(meta) });
  }

  process.stderr.write(line + "\n");
}

export const logger = {
  debug: (message: string, meta?: unknown) => write("debug", message, meta),
  info: (message: string, meta?: unknown) => write("info", message, meta),
  warn: (message: string, meta?: unknown) => write("warn", message, meta),
  error: (message: string, meta?: unknown) => write("error", message, meta),
};

export type Logger = typeof logger;
