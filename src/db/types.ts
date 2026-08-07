/** Shared row and query types for the persistence layer. */

/** Inclusive date/time range. Values are compared as TEXT (ISO strings). */
export interface DateRange {
  from: string;
  to: string;
}

export interface RepoRow {
  id: number;
  name: string | null;
  full_name: string | null;
  owner: string | null;
  private: number | null;
  fork: number | null;
  description: string | null;
  stars: number | null;
  forks: number | null;
  watchers: number | null;
  open_issues: number | null;
  primary_language: string | null;
  size_kb: number | null;
  default_branch: string | null;
  created_at: string | null;
  pushed_at: string | null;
  updated_at: string | null;
  archived: number | null;
  synced_at: string | null;
}

export interface CommitRow {
  sha: string;
  repo_id: number;
  author_login: string | null;
  author_email: string | null;
  committed_at: string | null;
  committed_date: string | null;
  hour: number | null;
  dow: number | null;
  additions: number | null;
  deletions: number | null;
  files_changed: number | null;
  message: string | null;
}

export interface StargazerRow {
  repo_id: number;
  user_login: string;
  starred_at: string | null;
}

export interface DailySnapshotRow {
  date: string;
  repo_id: number;
  stars: number | null;
  forks: number | null;
  open_issues: number | null;
  commits_count: number | null;
}

export interface HttpCacheRow {
  url_hash: string;
  url: string | null;
  etag: string | null;
  last_modified: string | null;
  body: string | null;
  fetched_at: string | null;
  expires_at: string | null;
}
