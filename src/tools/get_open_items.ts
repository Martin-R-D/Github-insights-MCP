import { z } from "zod";
import { defineTool } from "./types.js";
import { db } from "../db/client.js";
import { loadConfig } from "../config.js";
import { DAY_MS, resolveRepoRow } from "./_shared.js";

/**
 * MCP tool: open PRs and issues needing attention.
 *
 * NOTE on data limits: the sync layer persists PR/issue core fields but not
 * `draft`, review state, or labels. So:
 *   - draft is reported as false and review_state as null (unknown);
 *   - "bug"/"security" labels are *inferred from the title* (keyword match) and
 *     surfaced as heuristic labels — flagged in meta.note.
 * "No reply" for external issues is likewise approximated as "authored by
 * someone other than you" since comment threads aren't stored.
 */

const inputSchema = z
  .object({
    repo: z.string().optional(),
    include_drafts: z.boolean().default(false),
    only_mine: z.boolean().default(false),
    stale_days: z.number().int().min(1).max(365).default(14),
    limit: z.number().int().min(1).max(500).default(50),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

const SECURITY_RE = /(security|vulnerab|\bCVE\b|exploit|\bXSS\b|injection|\bRCE\b)/i;
const BUG_RE = /(\bbug\b|regression|\bcrash\b|broken|fails?\b|error)/i;

/** Heuristic labels inferred from the title (real labels aren't persisted). */
function inferLabels(title: string | null): string[] {
  const t = title ?? "";
  const labels: string[] = [];
  if (SECURITY_RE.test(t)) labels.push("security");
  if (BUG_RE.test(t)) labels.push("bug");
  return labels;
}

interface PrRow {
  repo: string;
  full_name: string | null;
  number: number;
  title: string | null;
  author_login: string | null;
  created_at: string | null;
}
type IssueRow = PrRow;

// Priority for needs_attention ordering (lower = more urgent).
const PRIORITY = { security: 0, bug: 1, stale_pr: 2, external_issue: 3 } as const;

export const getOpenItemsTool = defineTool({
  name: "get_open_items",
  description:
    "List open PRs and issues, flag stale ones and items needing attention (long-open PRs, external " +
    "issues awaiting reply, bug/security items). Labels and draft state are heuristic — see meta.note.",
  inputSchema,
  handler: (args: Input) => {
    const { GITHUB_USERNAME: username } = loadConfig();
    const nowMs = Date.now();

    let repoIds: number[] | null = null;
    if (args.repo) repoIds = [resolveRepoRow(args.repo).id];
    const repoClause = repoIds ? ` AND p.repo_id IN (${repoIds.map(() => "?").join(",")})` : "";
    const repoParams = repoIds ?? [];
    const mineClause = args.only_mine ? " AND p.author_login = ?" : "";
    const mineParams = args.only_mine ? [username] : [];

    const daysOpen = (createdAt: string | null): number => {
      if (!createdAt) return 0;
      return Math.max(0, Math.floor((nowMs - Date.parse(createdAt)) / DAY_MS));
    };
    const base = (full: string | null) => `https://github.com/${full ?? "unknown"}`;

    // --- Open PRs ---
    const prRows = db
      .prepare(
        `SELECT COALESCE(r.full_name, r.name, 'unknown') AS repo, r.full_name AS full_name,
                p.number AS number, p.title AS title, p.author_login AS author_login, p.created_at AS created_at
         FROM pull_requests p LEFT JOIN repos r ON r.id = p.repo_id
         WHERE p.state = 'open'${repoClause}${mineClause}
         ORDER BY p.created_at ASC`,
      )
      .all(...repoParams, ...mineParams) as PrRow[];

    const openPrs = prRows.map((p) => {
      const d = daysOpen(p.created_at);
      return {
        repo: p.repo,
        number: p.number,
        title: p.title,
        author: p.author_login,
        created_at: p.created_at,
        days_open: d,
        draft: false, // not persisted
        review_state: null as string | null, // not persisted
        is_stale: d > args.stale_days,
        url: `${base(p.full_name)}/pull/${p.number}`,
      };
    });
    // include_drafts is a no-op today (draft state isn't stored) but honored for
    // forward-compat: when false, exclude anything flagged draft.
    const visiblePrs = args.include_drafts ? openPrs : openPrs.filter((p) => !p.draft);

    // --- Open issues ---
    const issueRows = db
      .prepare(
        `SELECT COALESCE(r.full_name, r.name, 'unknown') AS repo, r.full_name AS full_name,
                p.number AS number, p.title AS title, p.author_login AS author_login, p.created_at AS created_at
         FROM issues p LEFT JOIN repos r ON r.id = p.repo_id
         WHERE p.state = 'open' AND p.is_pull_request = 0${repoClause}${mineClause}
         ORDER BY p.created_at ASC`,
      )
      .all(...repoParams, ...mineParams) as IssueRow[];

    const openIssues = issueRows.map((i) => {
      const d = daysOpen(i.created_at);
      return {
        repo: i.repo,
        number: i.number,
        title: i.title,
        author: i.author_login,
        created_at: i.created_at,
        days_open: d,
        labels: inferLabels(i.title),
        is_stale: d > args.stale_days,
        url: `${base(i.full_name)}/issues/${i.number}`,
      };
    });

    // --- needs_attention (dedup by key, keep highest priority) ---
    interface Candidate {
      type: "pr" | "issue";
      repo: string;
      number: number;
      title: string | null;
      reason: string;
      priority: number;
      days_open: number;
    }
    const candidates: Candidate[] = [];
    for (const p of visiblePrs) {
      const labels = inferLabels(p.title);
      if (labels.includes("security"))
        candidates.push({ type: "pr", repo: p.repo, number: p.number, title: p.title, reason: "labeled security", priority: PRIORITY.security, days_open: p.days_open });
      else if (labels.includes("bug"))
        candidates.push({ type: "pr", repo: p.repo, number: p.number, title: p.title, reason: "labeled bug", priority: PRIORITY.bug, days_open: p.days_open });
      if (p.is_stale)
        candidates.push({ type: "pr", repo: p.repo, number: p.number, title: p.title, reason: `PR open ${p.days_open} days (stale)`, priority: PRIORITY.stale_pr, days_open: p.days_open });
    }
    for (const i of openIssues) {
      if (i.labels.includes("security"))
        candidates.push({ type: "issue", repo: i.repo, number: i.number, title: i.title, reason: "labeled security", priority: PRIORITY.security, days_open: i.days_open });
      else if (i.labels.includes("bug"))
        candidates.push({ type: "issue", repo: i.repo, number: i.number, title: i.title, reason: "labeled bug", priority: PRIORITY.bug, days_open: i.days_open });
      if (i.author !== username)
        candidates.push({ type: "issue", repo: i.repo, number: i.number, title: i.title, reason: "external issue awaiting reply", priority: PRIORITY.external_issue, days_open: i.days_open });
    }
    // Keep the highest-priority reason per (type, repo, number).
    const bestByKey = new Map<string, Candidate>();
    for (const c of candidates) {
      const key = `${c.type}:${c.repo}#${c.number}`;
      const prev = bestByKey.get(key);
      if (!prev || c.priority < prev.priority) bestByKey.set(key, c);
    }
    const needsAttention = [...bestByKey.values()]
      .sort((a, b) => a.priority - b.priority || b.days_open - a.days_open)
      .map((c) => ({ type: c.type, repo: c.repo, number: c.number, title: c.title, reason: c.reason }));

    const stalePrs = visiblePrs.filter((p) => p.is_stale).length;
    const staleIssues = openIssues.filter((i) => i.is_stale).length;
    const fromOthers =
      visiblePrs.filter((p) => p.author !== username).length + openIssues.filter((i) => i.author !== username).length;

    const repoCount = new Set([...visiblePrs, ...openIssues].map((x) => x.repo)).size;

    // Summary.
    const attnBits: string[] = [];
    const sec = needsAttention.find((n) => n.reason === "labeled security");
    if (sec) {
      const secDetail = [...bestByKey.values()].find((c) => c.reason === "labeled security");
      attnBits.push(`a security-labeled ${sec.type === "pr" ? "PR" : "issue"} on ${sec.repo.split("/").pop()} open ${secDetail?.days_open ?? 0} days`);
    }
    const extPrs = needsAttention.filter((n) => n.reason.includes("stale") && n.type === "pr").length;
    if (extPrs) attnBits.push(`${extPrs} stale PR${extPrs === 1 ? "" : "s"} awaiting review`);
    const summary =
      `${visiblePrs.length} open PRs (${stalePrs} stale) and ${openIssues.length} open issues across ${repoCount} repos.` +
      (needsAttention.length ? ` ${needsAttention.length} need attention${attnBits.length ? ": " + attnBits.join(", ") : ""}.` : "");

    return {
      summary,
      data: {
        open_prs: visiblePrs.slice(0, args.limit),
        open_issues: openIssues.slice(0, args.limit),
        needs_attention: needsAttention,
        counts: {
          open_prs: visiblePrs.length,
          open_issues: openIssues.length,
          stale_prs: stalePrs,
          stale_issues: staleIssues,
          from_others: fromOthers,
        },
      },
      meta: {
        from_cache: true,
        stale: false,
        generated_at: new Date().toISOString(),
        repos_covered: repoCount,
        note: "draft/review_state aren't persisted (draft=false, review_state=null); bug/security labels are inferred from titles.",
      },
    };
  },
});
