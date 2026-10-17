---
name: github-insights-mcp
description: >
  MCP server that connects to the GitHub API and a local SQLite cache to give
  AI agents live insights about a developer's GitHub activity. Load this skill
  whenever the user asks about their GitHub stats, commit history, streaks,
  star growth, language breakdown, open PRs/issues, or wants a weekly developer
  report. Trigger phrases include: "how many commits", "my longest streak",
  "generate weekly report", "compare repos", "my GitHub activity", "star
  growth", "language breakdown", "open issues", "PR status", "busiest coding
  day", "contribution summary", "sync GitHub data".
triggers:
  - how many commits
  - my longest streak
  - generate weekly report
  - compare repos
  - my GitHub activity
  - star growth
  - language breakdown
  - open PRs
  - open issues
  - PR status
  - busiest coding day
  - contribution summary
  - sync GitHub data
  - GitHub stats
  - coding patterns
  - developer report
  - what did I ship this week
  - stale issues
  - polyglot score
  - repo comparison
---

# github-insights-mcp

An MCP server that exposes your GitHub activity as structured, queryable data.
It syncs repos, commits, stars, languages, PRs, and issues into a local SQLite
cache and surfaces them through 12 tools that an AI agent can call in natural
conversation.

## What this skill does

- Pulls live data from the GitHub REST and GraphQL APIs
- Maintains a local SQLite cache for fast, offline-capable queries
- Tracks commit streaks, heatmaps, and time-of-day patterns
- Reports star growth, language distribution, and repo health
- Generates structured weekly developer reports with week-over-week deltas
- Flags stale PRs, unanswered issues, and security-labelled items

## When to use it

Use this skill any time the user asks about **their own GitHub activity**:

| User says…                              | Tool to reach for              |
|-----------------------------------------|-------------------------------|
| "How many commits did I make this week?" | `get_commit_activity`         |
| "What's my current streak?"             | `get_commit_patterns`         |
| "Generate my weekly report"             | `generate_weekly_report`      |
| "Compare my top repos"                  | `compare_repos`               |
| "What languages do I write most?"       | `get_language_breakdown`      |
| "Show me my star growth"                | `get_stars_received`          |
| "What open PRs need attention?"         | `get_open_items`              |
| "Give me stats for repo X"              | `get_repo_stats`              |
| "List all my repos"                     | `get_all_repos`               |
| "Summarize my contributions this month" | `get_contribution_summary`    |
| "Refresh my GitHub data"                | `sync_github_data`            |
| "Is the server running?"                | `ping`                        |

---

## Available tools (12)

| Tool | Description |
|------|-------------|
| `ping` | Health check — returns `{ summary: "pong" }` to confirm the server is reachable. |
| `sync_github_data` | Sync repos, commits, stars, languages, PRs, and issues into the local cache. Pass `full=true` for a 365-day backfill; omit for an incremental update. |
| `get_all_repos` | List your repos from the local cache with totals. Filter forks/archived/private and sort by stars, updated, created, size, or name. |
| `get_commit_activity` | Aggregate commit activity over a window (default 30 days) by day/week/month, with a gap-filled timeline, per-repo breakdown, busiest day, and longest quiet stretch. |
| `get_commit_patterns` | Analyze commit patterns: longest/current streaks, most active day of the week, time-of-day distribution, 7×24 heatmap, and weekday-vs-weekend split. |
| `get_repo_stats` | Full stats for one repo: profile, stars/forks growth, commit activity, issue & PR throughput, language breakdown, and snapshot-based trend. |
| `get_stars_received` | Stars received over a period: total stars, daily gains, recent stargazers, per-repo growth, and fastest-growing repo. |
| `get_language_breakdown` | Language breakdown across your repos, weighted by bytes, repo count, or stars — with a polyglot score. |
| `get_contribution_summary` | Summarize contributions for a period (week/month/quarter/year/custom), optionally compared to the previous equal-length window, including a weekly trend line. Uses the GraphQL contribution calendar so private contributions are included. |
| `compare_repos` | Compare 2–5 repos over a period: stars, commits, activity, PRs/issues, and fairness-normalized per-month rates. |
| `get_open_items` | List open PRs and issues; flags stale items, long-open PRs, external issues awaiting reply, and bug/security items. |
| `generate_weekly_report` | Generate a Mon–Sun activity report: headline metrics, week-over-week deltas, per-repo work, what shipped, commit patterns, community engagement, and items needing attention. |

---

## Setup requirements

The server reads configuration from environment variables (or a `.env` file in
the working directory):

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | Personal access token with `repo` and `read:user` scopes. |
| `GITHUB_USERNAME` | Yes | Your GitHub username (e.g. `octocat`). |
| `TIMEZONE` | No | IANA timezone string (default `UTC`). E.g. `America/New_York`. |
| `DB_PATH` | No | Path to the SQLite database file (default `./data/github.db`). |

**Do not hardcode secrets.** Store `GITHUB_TOKEN` in your environment or a
`.env` file that is excluded from version control.

---

## Installation

```bash
# Install from npm
npm install -g github-insights-mcp

# Or run directly via npx (no install needed)
npx github-insights-mcp
```

Add to your Claude Desktop (or any MCP host) config:

```json
{
  "mcpServers": {
    "github-insights": {
      "command": "npx",
      "args": ["github-insights-mcp"],
      "env": {
        "GITHUB_TOKEN": "<your-token>",
        "GITHUB_USERNAME": "<your-username>",
        "TIMEZONE": "America/New_York"
      }
    }
  }
}
```

---

## Links

- npm: https://www.npmjs.com/package/github-insights-mcp
- GitHub: https://github.com/Martin-R-D/Github-insights-MCP
