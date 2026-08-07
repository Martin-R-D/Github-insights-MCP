import { describe, expect, it } from "vitest";
import { ToolError, toToolResult } from "./errors.js";

describe("toToolResult", () => {
  it("shapes a ToolError with its code, message and hint", () => {
    const err = new ToolError("not_found", "No such repo", "Check the name");
    expect(toToolResult(err)).toEqual({
      error: { code: "not_found", message: "No such repo", hint: "Check the name" },
    });
  });

  it("omits hint when absent", () => {
    const err = new ToolError("rate_limited", "Slow down");
    expect(toToolResult(err)).toEqual({
      error: { code: "rate_limited", message: "Slow down" },
    });
  });

  it("wraps a plain Error as internal_error", () => {
    const result = toToolResult(new Error("boom"));
    expect(result.error.code).toBe("internal_error");
    expect(result.error.message).toBe("boom");
  });

  it("handles non-Error throwables", () => {
    expect(toToolResult("weird").error.code).toBe("internal_error");
    expect(toToolResult(42).error.message).toMatch(/unexpected/i);
  });
});
