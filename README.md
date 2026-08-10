# Github-insights-mcp

An [MCP](https://modelcontextprotocol.io) server that gives Claude (and other
MCP clients) rich insights about your GitHub activity: commit patterns, streaks,
stars over time, language mix, PR/issue throughput, repo comparisons and a
ready-to-paste weekly report. It talks JSON-RPC over **stdio** and caches
everything locally in SQLite, so questions are fast and work offline once
synced.

Because it keeps a local `daily_snapshots` table, it also accumulates the
historical stars/forks/issues trend that GitHub's API does **not** retain.

---

## 1. Get a GitHub Personal Access Token (PAT)

This server needs read access to your profile, repositories, and organizations.
A **classic** PAT with the scopes below is the simplest option.

1. Open <https://github.com/settings/tokens> → **Generate new token → classic**.
2. Name it (e.g. `github-insights-mcp`) and pick an expiration.
3. Select exactly these scopes:
   - **`repo`** — read repository data (commits, PRs, issues), including private repos.
   - **`read:user`** — read your profile and activity.
   - **`read:org`** — read org membership and org-owned repositories.
4. **Generate token** and copy it (GitHub shows it once).

> The server verifies the token on startup and **warns** if a classic PAT has
> more scopes than needed. Prefer a fine-grained token? Grant read-only
> Contents, Metadata, Pull requests and Issues on the target repos, plus account
> read for profile/org. The token is never logged and is redacted from any error
> output.

If your organization uses **SSO**, click **Configure SSO / Authorize** next to
the token so it can read org repos.

---

## 2. Install & configure

### Option A — via `npx` (recommended for Claude Desktop)

No local clone needed; Claude Desktop launches it on demand (see below).

### Option B — from source

```bash
git clone <this-repo> && cd github-insights-mcp
npm install
cp .env.example .env      # fill in GITHUB_TOKEN and GITHUB_USERNAME
npm run build
npm start                 # starts the stdio server
```

### Configuration (environment variables)

| Variable          | Required | Default            | Description                                              |
| ----------------- | -------- | ------------------ | -------------------------------------------------------- |
| `GITHUB_TOKEN`    | yes      | —                  | Classic PAT with `repo, read:user, read:org`.            |
| `GITHUB_USERNAME` | yes      | —                  | The GitHub login to analyze.                             |
| `TIMEZONE`        | no       | `UTC`              | IANA zone, e.g. `America/New_York`, `Europe/Sofia`.      |
| `DB_PATH`         | no       | `./data/github.db` | Path to the local SQLite cache.                          |
| `LOG_LEVEL`       | no       | `info`             | `debug` \| `info` \| `warn` \| `error`.                  |

---

## 3. Connect to Claude Desktop

Add this block to your `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`,
Windows: `%APPDATA%\Claude\claude_desktop_config.json`), then restart Claude
Desktop:

```json
{
  "mcpServers": {
    "github-insights": {
      "command": "npx",
      "args": ["-y", "github-insights-mcp"],
      "env": {
        "GITHUB_TOKEN": "...",
        "GITHUB_USERNAME": "...",
        "TIMEZONE": "America/New_York"
      }
    }
  }
}
```

If you installed from source, use your built binary instead:

```json
{
  "mcpServers": {
    "github-insights": {
      "command": "node",
      "args": ["/absolute/path/to/github-insights-mcp/dist/index.js"],
      "env": { "GITHUB_TOKEN": "...", "GITHUB_USERNAME": "...", "TIMEZONE": "America/New_York" }
    }
  }
}
```

**First run:** the DB starts empty, so the server kicks off an initial sync in
the background. Until it finishes, every tool replies with a friendly
"still syncing, N repos done" message instead of empty data. Give it a minute or
two, then ask again.

---

## 4. Tools & example questions

| Tool                        | Ask Claude…                                                                 |
| --------------------------- | --------------------------------------------------------------------------- |
| `get_all_repos`             | "List my repos by stars." / "Which repos did I push to most recently?"      |
| `get_commit_activity`       | "How many commits did I make in the last 30 days?" / "Show my commit timeline by week." |
| `get_commit_patterns`       | "What's my longest commit streak?" / "Which day of the week do I commit most?" / "What time of day do I push?" |
| `get_repo_stats`            | "Give me full stats for keystrike." / "How fast is musicflow growing?"      |
| `get_stars_received`        | "Who starred my repos recently?" / "Which repo is growing fastest?"         |
| `get_language_breakdown`    | "What languages do I write most?" / "How polyglot am I?"                     |
| `get_contribution_summary`  | "Am I coding more than last month?" / "How many PRs have I opened this year?" |
| `compare_repos`             | "Compare keystrike and musicflow." / "Which of my projects is the most active?" |
| `get_open_items`            | "What PRs and issues need my attention?" / "Any stale PRs?"                  |
| `generate_weekly_report`    | "Generate my weekly report." / "Give me last week's report as markdown."    |
| `sync_github_data`          | "Refresh my GitHub data." / "Do a full backfill."                           |

Every tool returns `{ summary, data, meta }`: `summary` is a short spoken-style
recap, `data` is the structured detail, `meta` carries freshness/period info.

---

## 5. Scheduled daily sync (keep trend history growing)

`daily_snapshots` can only record what it sees each day, so run a sync once a day
to build up stars/forks/issues history over time. The bundled script runs
`syncAll()` then `snapshotToday()`:

```bash
npm run sync            # = node dist/scripts/sync-cron.js
node dist/scripts/sync-cron.js --full   # occasional full backfill
```

### cron (Linux/macOS)

```cron
# Every day at 07:00 — adjust the path and env as needed
0 7 * * *  cd /path/to/github-insights-mcp && \
  GITHUB_TOKEN=... GITHUB_USERNAME=... TIMEZONE=America/New_York \
  /usr/bin/node dist/scripts/sync-cron.js >> data/sync.log 2>&1
```

### launchd (macOS) — `~/Library/LaunchAgents/com.github-insights.sync.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.github-insights.sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/github-insights-mcp/dist/scripts/sync-cron.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GITHUB_TOKEN</key><string>...</string>
    <key>GITHUB_USERNAME</key><string>...</string>
    <key>TIMEZONE</key><string>America/New_York</string>
  </dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
</dict>
</plist>
```

Load it with `launchctl load ~/Library/LaunchAgents/com.github-insights.sync.plist`.

### Windows Task Scheduler

Create a Basic Task → Daily → Action "Start a program":
`node.exe` with arguments `C:\path\to\github-insights-mcp\dist\scripts\sync-cron.js`,
and set the three env vars in the task (or via a wrapper `.cmd`).

---

## 6. Troubleshooting

- **Empty results right after adding the server.** The first sync runs in the
  background; tools reply "still syncing, N repos done" until it completes. Wait
  a minute and retry. You can also run `npm run sync` once manually.
- **Rate limits.** The server caches with ETags and tracks your remaining quota.
  If you're near the limit it serves cached data (flagged `stale`) rather than
  failing. Authenticated REST is 5,000 requests/hour; a full backfill of many
  repos can approach that — run it once, then rely on incremental daily syncs.
- **Private repos missing.** Your token needs the `repo` scope (not just
  `public_repo`). Regenerate the PAT with `repo` if needed.
- **Org repos missing / 403 on startup.** If your org enforces **SSO**, open the
  token settings and **Authorize** the token for that organization. A 403 at
  startup usually means SSO authorization or a missing `read:org` scope.
- **"Bad credentials" / server won't start.** The token is invalid, expired, or
  revoked. The server exits with a clear stderr message before connecting, so
  Claude Desktop shows the reason — set a valid `GITHUB_TOKEN`.
- **Nothing appears in Claude.** Check that `command`/`args` are correct and that
  env vars are set in the config block. Server logs go to **stderr**; view them
  in Claude Desktop's MCP logs.

> **Protocol note:** stdout is reserved exclusively for the MCP JSON-RPC
> protocol. All logging goes to **stderr** — writing anything else to stdout
> would corrupt the stream and break the connection.

---

## 7. Development

```bash
npm run dev        # tsup watch + restart
npm run build      # bundle to dist/ (with #!/usr/bin/env node shebang)
npm run sync       # run a scheduled sync + snapshot
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests and build on Node 20
and 22 for every push and PR.

### Project layout

```
src/
  index.ts              # MCP server: token verify, first-run sync, dispatch, shutdown
  config.ts             # env loading & validation
  db/                   # SQLite schema + typed repository modules
  github/               # Octokit client (ETag cache, retries), GraphQL, token verify
  services/             # sync orchestration, report generation, first-run bootstrap
  tools/                # the MCP tools (one file each) + registry
  scripts/sync-cron.ts  # scheduled sync + snapshot entry point
  utils/                # stderr logger (with secret redaction), errors
```

## License

MIT
