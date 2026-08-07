-- Persistence schema for github-insights-mcp.
-- All statements are idempotent (IF NOT EXISTS) so the file can be re-run.

CREATE TABLE IF NOT EXISTS repos (
  id               INTEGER PRIMARY KEY,
  name             TEXT,
  full_name        TEXT,
  owner            TEXT,
  private          INTEGER,
  fork             INTEGER,
  description      TEXT,
  stars            INTEGER,
  forks            INTEGER,
  watchers         INTEGER,
  open_issues      INTEGER,
  primary_language TEXT,
  size_kb          INTEGER,
  default_branch   TEXT,
  created_at       TEXT,
  pushed_at        TEXT,
  updated_at       TEXT,
  archived         INTEGER,
  synced_at        TEXT
);

CREATE TABLE IF NOT EXISTS commits (
  sha            TEXT PRIMARY KEY,
  repo_id        INTEGER,
  author_login   TEXT,
  author_email   TEXT,
  committed_at   TEXT,
  committed_date TEXT,
  hour           INTEGER,
  dow            INTEGER,
  additions      INTEGER,
  deletions      INTEGER,
  files_changed  INTEGER,
  message        TEXT
);

CREATE TABLE IF NOT EXISTS repo_languages (
  repo_id   INTEGER,
  language  TEXT,
  bytes     INTEGER,
  synced_at TEXT,
  PRIMARY KEY (repo_id, language)
);

CREATE TABLE IF NOT EXISTS stargazers (
  repo_id    INTEGER,
  user_login TEXT,
  starred_at TEXT,
  PRIMARY KEY (repo_id, user_login)
);

CREATE TABLE IF NOT EXISTS pull_requests (
  id           INTEGER PRIMARY KEY,
  repo_id      INTEGER,
  number       INTEGER,
  state        TEXT,
  title        TEXT,
  author_login TEXT,
  created_at   TEXT,
  merged_at    TEXT,
  closed_at    TEXT,
  additions    INTEGER,
  deletions    INTEGER
);

CREATE TABLE IF NOT EXISTS issues (
  id              INTEGER PRIMARY KEY,
  repo_id         INTEGER,
  number          INTEGER,
  state           TEXT,
  title           TEXT,
  author_login    TEXT,
  created_at      TEXT,
  closed_at       TEXT,
  is_pull_request INTEGER
);

CREATE TABLE IF NOT EXISTS daily_snapshots (
  date          TEXT,
  repo_id       INTEGER,
  stars         INTEGER,
  forks         INTEGER,
  open_issues   INTEGER,
  commits_count INTEGER,
  PRIMARY KEY (date, repo_id)
);

CREATE TABLE IF NOT EXISTS sync_state (
  resource       TEXT PRIMARY KEY,
  repo_id        INTEGER,
  last_cursor    TEXT,
  last_synced_at TEXT,
  etag           TEXT
);

CREATE TABLE IF NOT EXISTS http_cache (
  url_hash      TEXT PRIMARY KEY,
  url           TEXT,
  etag          TEXT,
  last_modified TEXT,
  body          TEXT,
  fetched_at    TEXT,
  expires_at    TEXT
);

-- Indexes -------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_commits_repo_date  ON commits (repo_id, committed_date);
CREATE INDEX IF NOT EXISTS idx_commits_date       ON commits (committed_date);
CREATE INDEX IF NOT EXISTS idx_commits_dow        ON commits (dow);
CREATE INDEX IF NOT EXISTS idx_commits_hour       ON commits (hour);
CREATE INDEX IF NOT EXISTS idx_stargazers_starred ON stargazers (starred_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_date     ON daily_snapshots (date);
CREATE INDEX IF NOT EXISTS idx_pr_repo_created    ON pull_requests (repo_id, created_at);
