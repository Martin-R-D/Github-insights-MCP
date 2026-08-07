import { getGithubClient } from "./client.js";

/**
 * Thin, typed wrappers around GitHub REST routes. Each picks a sensible cache
 * TTL. These return the raw GitHub payload shapes (kept loose on purpose — the
 * sync layer maps them into DB rows).
 */

// TTLs in seconds.
const TTL = {
  repos: 15 * 60,
  repo: 10 * 60,
  commits: 5 * 60,
  commit: 24 * 60 * 60,
  languages: 24 * 60 * 60,
  stargazers: 30 * 60,
  pulls: 10 * 60,
  issues: 10 * 60,
} as const;

export interface RepoSummary {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string } | null;
  private: boolean;
  fork: boolean;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  watchers_count: number;
  open_issues_count: number;
  language: string | null;
  size: number;
  default_branch: string;
  created_at: string | null;
  pushed_at: string | null;
  updated_at: string | null;
  archived: boolean;
  [key: string]: unknown;
}

export interface CommitSummary {
  sha: string;
  commit: {
    author: { name?: string; email?: string; date?: string } | null;
    message: string;
  };
  author: { login?: string } | null;
  stats?: { additions: number; deletions: number; total: number };
  files?: unknown[];
  [key: string]: unknown;
}

export interface StargazerWithTime {
  starred_at: string;
  user: { login: string } | null;
}

export interface PullRequestSummary {
  id: number;
  number: number;
  state: string;
  title: string;
  user: { login: string } | null;
  created_at: string | null;
  merged_at: string | null;
  closed_at: string | null;
  additions?: number;
  deletions?: number;
  [key: string]: unknown;
}

export interface IssueSummary {
  id: number;
  number: number;
  state: string;
  title: string;
  user: { login: string } | null;
  created_at: string | null;
  closed_at: string | null;
  pull_request?: unknown;
  [key: string]: unknown;
}

export interface ListReposParams {
  visibility?: "all" | "public" | "private";
  affiliation?: string;
  sort?: "created" | "updated" | "pushed" | "full_name";
  maxPages?: number;
}

/** Repos accessible to the authenticated user. */
export function listUserRepos(params: ListReposParams = {}): Promise<RepoSummary[]> {
  const { maxPages, ...rest } = params;
  return getGithubClient().paginateAll<RepoSummary>(
    "GET /user/repos",
    { visibility: "all", affiliation: "owner,collaborator,organization_member", sort: "pushed", ...rest },
    { ttlSeconds: TTL.repos, maxPages },
  );
}

export async function getRepo(owner: string, repo: string): Promise<RepoSummary> {
  const res = await getGithubClient().cachedRequest<RepoSummary>(
    "GET /repos/{owner}/{repo}",
    { owner, repo },
    { ttlSeconds: TTL.repo },
  );
  return res.data;
}

export interface ListCommitsParams {
  since?: string;
  until?: string;
  author?: string;
  maxPages?: number;
}

export function listRepoCommits(owner: string, repo: string, params: ListCommitsParams = {}): Promise<CommitSummary[]> {
  const { maxPages, ...rest } = params;
  return getGithubClient().paginateAll<CommitSummary>(
    "GET /repos/{owner}/{repo}/commits",
    { owner, repo, ...rest },
    { ttlSeconds: TTL.commits, maxPages },
  );
}

/** Single commit incl. stats (additions/deletions). Long TTL: immutable. */
export async function getCommit(owner: string, repo: string, ref: string): Promise<CommitSummary> {
  const res = await getGithubClient().cachedRequest<CommitSummary>(
    "GET /repos/{owner}/{repo}/commits/{ref}",
    { owner, repo, ref },
    { ttlSeconds: TTL.commit },
  );
  return res.data;
}

export async function listRepoLanguages(owner: string, repo: string): Promise<Record<string, number>> {
  const res = await getGithubClient().cachedRequest<Record<string, number>>(
    "GET /repos/{owner}/{repo}/languages",
    { owner, repo },
    { ttlSeconds: TTL.languages },
  );
  return res.data;
}

/** Stargazers with starred_at timestamps (requires the star+json media type). */
export function listStargazersWithTimestamps(owner: string, repo: string, maxPages?: number): Promise<StargazerWithTime[]> {
  return getGithubClient().paginateAll<StargazerWithTime>(
    "GET /repos/{owner}/{repo}/stargazers",
    { owner, repo, headers: { accept: "application/vnd.github.star+json" } },
    { ttlSeconds: TTL.stargazers, maxPages },
  );
}

export interface ListPullsParams {
  state?: "open" | "closed" | "all";
  maxPages?: number;
}

export function listPullRequests(owner: string, repo: string, params: ListPullsParams = {}): Promise<PullRequestSummary[]> {
  const { maxPages, ...rest } = params;
  return getGithubClient().paginateAll<PullRequestSummary>(
    "GET /repos/{owner}/{repo}/pulls",
    { owner, repo, state: "all", ...rest },
    { ttlSeconds: TTL.pulls, maxPages },
  );
}

export interface ListIssuesParams {
  state?: "open" | "closed" | "all";
  maxPages?: number;
}

export function listIssues(owner: string, repo: string, params: ListIssuesParams = {}): Promise<IssueSummary[]> {
  const { maxPages, ...rest } = params;
  return getGithubClient().paginateAll<IssueSummary>(
    "GET /repos/{owner}/{repo}/issues",
    { owner, repo, state: "all", ...rest },
    { ttlSeconds: TTL.issues, maxPages },
  );
}
