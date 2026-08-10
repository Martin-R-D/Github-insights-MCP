import { afterEach, describe, expect, it, vi } from "vitest";
import { logger, redactSecret } from "./logger.js";

describe("logger secret redaction", () => {
  afterEach(() => vi.restoreAllMocks());

  function capture(fn: () => void): string {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    fn();
    spy.mockRestore();
    return writes.join("");
  }

  it("scrubs a registered secret from messages and meta", () => {
    const secret = "supersecrettoken1234567890";
    redactSecret(secret);
    const out = capture(() => {
      logger.info(`authorizing with ${secret}`, { token: secret });
    });
    expect(out).not.toContain(secret);
    expect(out).toContain("***REDACTED***");
  });

  it("scrubs anything that looks like a GitHub token even if unregistered", () => {
    const looksLikeToken = "ghp_" + "A".repeat(30);
    const out = capture(() => logger.error("boom", { hint: looksLikeToken }));
    expect(out).not.toContain(looksLikeToken);
    expect(out).toContain("***REDACTED***");
  });
});
