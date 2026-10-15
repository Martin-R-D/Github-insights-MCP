# github-insights-mcp — Agensi Skill

Bring your GitHub activity into any MCP-compatible AI agent. This skill wraps
the `github-insights-mcp` MCP server, which syncs your repos, commits, stars,
languages, PRs, and issues into a local SQLite cache and exposes them as 12
structured tools your agent can call conversationally.

---

## What you get

- **Commit analytics** — daily/weekly/monthly timelines, gap detection, busiest day
- **Streak tracking** — current and longest coding streaks, 7×24 heatmap
- **Star growth** — per-repo star gains, fastest-growing repo, recent stargazers
- **Language breakdown** — weighted by bytes, repo count, or stars; polyglot score
- **Contribution summary** — week/month/quarter/year with week-over-week trend, including private contributions via the GraphQL calendar
- **Repo comparison** — fairness-normalized side-by-side stats for 2–5 repos
- **Open items dashboard** — stale PRs, unanswered issues, security-flagged items
- **Weekly developer report** — headline metrics, what shipped, patterns, and action items

All 12 tools work from a local SQLite cache, so most queries are instant after the first sync.

---

## Quick start

### 1. Install

```bash
npm install -g github-insights-mcp
```

Or skip the install and use `npx github-insights-mcp` directly.

### 2. Create a GitHub token

Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens** and create a token with:
- `Contents` (read) — for commit data
- `Metadata` (read) — for repo info
- `Pull requests` (read) and `Issues` (read) — for PR/issue tracking

### 3. Configure your MCP host

Add this block to your MCP host config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "github-insights": {
      "command": "npx",
      "args": ["github-insights-mcp"],
      "env": {
        "GITHUB_TOKEN": "<your-token>",
        "GITHUB_USERNAME": "<your-github-username>",
        "TIMEZONE": "America/New_York"
      }
    }
  }
}
```

### 4. Run your first sync

Ask your agent:

> "Sync my GitHub data"

This runs a full 365-day backfill. Subsequent syncs are incremental and much faster.

### 5. Start asking questions

- "What's my current commit streak?"
- "Compare my top three repos this quarter"
- "Generate my weekly developer report"
- "Which language do I write most?"
- "Show me open PRs that need attention"

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | Yes | — | GitHub personal access token |
| `GITHUB_USERNAME` | Yes | — | Your GitHub username |
| `TIMEZONE` | No | `UTC` | IANA timezone (e.g. `Europe/London`) |
| `DB_PATH` | No | `./data/github.db` | Path to the SQLite database file |

---

## Links

- npm: https://www.npmjs.com/package/github-insights-mcp
- GitHub: https://github.com/Martin-R-D/Github-insights-MCP
