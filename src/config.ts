import "dotenv/config";
import { z } from "zod";

/**
 * Loads and validates environment configuration. Fails fast with a single,
 * readable message that lists every missing or invalid variable rather than
 * dying on the first problem.
 */

// Validate that a string is a usable IANA time zone by asking the runtime's
// Intl implementation. Throws for unknown zones, which we catch and report.
function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

const configSchema = z.object({
  GITHUB_TOKEN: z
    .string({ required_error: "GITHUB_TOKEN is required" })
    .trim()
    .min(1, "GITHUB_TOKEN must not be empty"),

  GITHUB_USERNAME: z
    .string({ required_error: "GITHUB_USERNAME is required" })
    .trim()
    .min(1, "GITHUB_USERNAME must not be empty"),

  TIMEZONE: z
    .string()
    .trim()
    .default("UTC")
    .refine(isValidTimeZone, {
      message: "TIMEZONE must be a valid IANA time zone (e.g. UTC, America/New_York)",
    }),

  DB_PATH: z.string().trim().min(1).default("./data/github.db"),

  LOG_LEVEL: z
    .enum(LOG_LEVELS, {
      errorMap: () => ({ message: `LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}` }),
    })
    .default("info"),
});

export type Config = z.infer<typeof configSchema>;

let cached: Config | undefined;

/**
 * Parse and cache configuration. Throws an Error with a multi-line, readable
 * summary of all validation problems if anything is missing or invalid.
 */
export function loadConfig(): Config {
  if (cached) return cached;

  const parsed = configSchema.safeParse(process.env);

  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const field = issue.path.join(".") || "(root)";
      return `  - ${field}: ${issue.message}`;
    });

    throw new Error(
      [
        "Invalid environment configuration. Fix the following and try again:",
        ...lines,
        "",
        "Tip: copy .env.example to .env and fill in the required values.",
      ].join("\n"),
    );
  }

  cached = parsed.data;
  return cached;
}
