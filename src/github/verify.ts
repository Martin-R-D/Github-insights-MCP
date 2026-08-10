import { getGithubClient, type GithubClient } from "./client.js";

/**
 * Startup token verification. Calls GET /user so we fail fast (before the MCP
 * handshake) with a clear, actionable reason instead of surfacing cryptic
 * errors later inside a tool call.
 */

export type TokenProblem = "bad_token" | "forbidden" | "network" | "unknown";

export class TokenVerificationError extends Error {
  readonly kind: TokenProblem;
  constructor(kind: TokenProblem, message: string) {
    super(message);
    this.name = "TokenVerificationError";
    this.kind = kind;
    Object.setPrototypeOf(this, TokenVerificationError.prototype);
  }
}

export interface TokenInfo {
  login: string;
  /** OAuth scopes for a classic PAT; empty for fine-grained tokens. */
  scopes: string[];
  /** True when GitHub returned an x-oauth-scopes header (classic PAT / OAuth). */
  classic: boolean;
}

// Scopes this server actually needs. Anything beyond these (on a classic PAT)
// is over-provisioned and worth a warning.
export const NEEDED_SCOPES = ["repo", "read:user", "read:org"] as const;
// Scopes that are harmless subsets/relatives of the needed ones.
const BENIGN_SCOPES = new Set<string>([
  "repo",
  "repo:status",
  "repo_deployment",
  "public_repo",
  "read:user",
  "user",
  "user:email",
  "read:org",
]);

/**
 * Verify the token by fetching the authenticated user. Throws a
 * TokenVerificationError classified as bad_token / forbidden / network.
 */
export async function verifyToken(client: GithubClient = getGithubClient()): Promise<TokenInfo> {
  try {
    const res = await client.octokit.request("GET /user");
    const headers = res.headers as Record<string, string | undefined>;
    const raw = headers["x-oauth-scopes"];
    const scopes = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    return {
      login: (res.data as { login?: string }).login ?? "unknown",
      scopes,
      classic: raw !== undefined,
    };
  } catch (err) {
    const e = err as { status?: number; message?: string };
    if (e.status === 401) {
      throw new TokenVerificationError(
        "bad_token",
        "GitHub rejected the token (401 Unauthorized). GITHUB_TOKEN is invalid, expired, or revoked.",
      );
    }
    if (e.status === 403) {
      throw new TokenVerificationError(
        "forbidden",
        "GitHub returned 403 Forbidden for GET /user. The token may lack the read:user scope, or SSO authorization is required for your org.",
      );
    }
    if (e.status === undefined || e.status === 0) {
      throw new TokenVerificationError(
        "network",
        `Could not reach the GitHub API (network error): ${e.message ?? "unknown network failure"}.`,
      );
    }
    throw new TokenVerificationError("unknown", `Unexpected error verifying token (HTTP ${e.status}): ${e.message ?? ""}`);
  }
}

/**
 * Return a human-readable warning if a *classic* PAT carries scopes beyond what
 * this server needs, or null if scopes look fine (or the token is fine-grained).
 */
export function overScopedWarning(info: TokenInfo): string | null {
  if (!info.classic || info.scopes.length === 0) return null;
  const extra = info.scopes.filter((s) => !BENIGN_SCOPES.has(s));
  if (extra.length === 0) return null;
  return (
    `Your classic PAT has more scopes than this server needs (${extra.join(", ")}). ` +
    `Only ${NEEDED_SCOPES.join(", ")} are required; consider a token with fewer scopes to limit blast radius.`
  );
}
