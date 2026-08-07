# github-insights-mcp

An [MCP](https://modelcontextprotocol.io) server that exposes insights about a
GitHub user's activity to MCP-compatible clients (Claude, editors, etc.). It
talks JSON-RPC over **stdio** and caches data locally in SQLite.

## Requirements

- Node.js **20+**
- A GitHub personal access token (see below)

## Quick start

```bash
npm install
cp .env.example .env      # then fill in the values
npm run build
npm start
```

For development with rebuild-on-save:

```bash
npm run dev
```

Run the tests:

```bash
npm test
```

## Configuration

Configuration is read from the environment (a local `.env` is loaded
automatically). All variables are validated at startup; if anything is missing
or invalid the server prints **every** problem at once and exits.

| Variable          | Required | Default            | Description                                             |
| ----------------- | -------- | ------------------ | ------------------------------------------------------- |
| `GITHUB_TOKEN`    | yes      | —                  | GitHub PAT (see scopes below). Must be non-empty.       |
| `GITHUB_USERNAME` | yes      | —                  | The GitHub login to analyze.                            |
| `TIMEZONE`        | no       | `UTC`              | IANA time zone, e.g. `America/New_York`, `Europe/Sofia`.|
| `DB_PATH`         | no       | `./data/github.db` | Path to the local SQLite cache.                         |
| `LOG_LEVEL`       | no       | `info`             | `debug` \| `info` \| `warn` \| `error`.                 |

> **Protocol note:** the server logs to **stderr only**. stdout is reserved for
> the MCP transport — writing to it would corrupt the JSON-RPC stream.

## Generating a GitHub Personal Access Token (PAT)

This server needs read access to your profile, your repositories, and your
organizations. A **classic** PAT with the scopes below is the simplest option.

1. Go to **GitHub → Settings → Developer settings → Personal access tokens →
   Tokens (classic)**, or open
   <https://github.com/settings/tokens>.
2. Click **Generate new token → Generate new token (classic)**.
3. Give it a name (e.g. `github-insights-mcp`) and an expiration.
4. Select these scopes:
   - **`repo`** — read access to repository data (commits, PRs, issues),
     including private repositories.
   - **`read:user`** — read your profile and activity.
   - **`read:org`** — read organization membership and org-owned repositories.
5. Click **Generate token** and copy the value **immediately** — GitHub only
   shows it once.
6. Put it in your `.env`:

   ```dotenv
   GITHUB_TOKEN=ghp_your_token_here
   GITHUB_USERNAME=your-login
   ```

> Prefer a **fine-grained** token? Grant read-only access to the target repos
> with the equivalent permissions (Contents: Read, Metadata: Read, Pull
> requests: Read, Issues: Read) plus account permissions for profile and org
> read. Classic scopes are documented here because they map 1:1 to the
> requirements above.

Keep the token secret. `.env` is git-ignored; never commit it.

## Available tools

| Tool   | Description                                                              |
| ------ | ----------------------------------------------------------------------- |
| `ping` | Health check. Returns `{ "summary": "pong" }` to verify the handshake.  |

More tools will be added to the registry in `src/tools/`.

## Project layout

```
src/
  index.ts          # MCP server: ListTools + CallTool dispatch over stdio
  config.ts         # env loading & zod validation (fail-fast)
  tools/
    index.ts        # tool registry (array + name lookup map)
    types.ts        # ToolDefinition type + defineTool helper
    ping.ts         # placeholder tool
  utils/
    logger.ts       # stderr-only structured logger
    errors.ts       # ToolError + toToolResult
```

### Adding a tool

1. Create `src/tools/my-tool.ts` and export a `defineTool({ ... })` with a
   `name`, `description`, zod `inputSchema`, and `handler`.
2. Add it to the `tools` array in `src/tools/index.ts`.

The server converts the zod schema to JSON Schema for `ListTools` and validates
incoming arguments against it before invoking your handler.

## License

MIT
