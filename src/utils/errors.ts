/**
 * Structured error handling for tool handlers.
 *
 * Tool handlers should throw `ToolError` for expected, user-facing failures
 * (bad input, missing resource, rate limiting, etc.). `toToolResult` converts
 * any thrown value into a stable, serializable shape so the MCP layer can
 * return a well-formed result instead of crashing.
 */

export type ToolErrorCode =
  | "invalid_input"
  | "not_found"
  | "unauthorized"
  | "rate_limited"
  | "upstream_error"
  | "internal_error";

export interface ToolErrorShape {
  error: {
    code: ToolErrorCode;
    message: string;
    hint?: string;
  };
}

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly hint?: string;

  constructor(code: ToolErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.hint = hint;
    // Preserve prototype chain when targeting ES2022 / transpiled output.
    Object.setPrototypeOf(this, ToolError.prototype);
  }
}

/**
 * Shape any thrown value into `{ error: { code, message, hint } }`.
 * Never throws.
 */
export function toToolResult(err: unknown): ToolErrorShape {
  if (err instanceof ToolError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        ...(err.hint ? { hint: err.hint } : {}),
      },
    };
  }

  if (err instanceof Error) {
    return {
      error: {
        code: "internal_error",
        message: err.message || "An unexpected error occurred.",
      },
    };
  }

  return {
    error: {
      code: "internal_error",
      message: typeof err === "string" ? err : "An unexpected error occurred.",
    },
  };
}
