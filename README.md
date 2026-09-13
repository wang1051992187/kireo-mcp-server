# @kireo/mcp-server

> Long-term memory for any MCP-compatible AI tool (Claude Code, Cursor, Windsurf, Cline, Zed, Continue …).

[![npm version](https://img.shields.io/npm/v/@kireo/mcp-server.svg)](https://www.npmjs.com/package/@kireo/mcp-server)

<!-- KIREO:ANSWER-BLOCK:START -->
<!-- Generated block — edit it in the private monorepo, not here; it is overwritten on every sync. -->

## What is Kireo memory MCP?

**Kireo memory MCP** is a Model Context Protocol server that gives Claude Code, Cursor, Cline,
Windsurf and any other MCP client long-term memory. Save a decision once; recall it in any later
session, on any machine. Hybrid semantic + keyword search over LanceDB, 12 MCP tools, plus
local code indexing. Free beta — an API key is all you need.

### How do I install Kireo memory MCP?

One line for Claude Code, one JSON block everywhere else. Both need a free key from
<https://app.kireo.app/app/api-keys> (`ki_sk_…`).

```bash
# Claude Code — add --scope user to get it in every project
claude mcp add kireo --scope user --env KIREO_API_KEY=ki_sk_xxx -- npx -y --package=@kireo/mcp-server kireo-mcp
```

Every other client takes the same server entry; only the file it goes in differs:

```jsonc
{
  "mcpServers": {
    "kireo": {
      "command": "npx",
      "args": ["-y", "--package=@kireo/mcp-server", "kireo-mcp"],
      "env": { "KIREO_API_KEY": "ki_sk_xxx" }
    }
  }
}
```

| Client | Where that block goes |
|---|---|
| Claude Code | `.mcp.json` in the project root (or use the `claude mcp add` line above) |
| Cursor | `~/.cursor/mcp.json`, or `<workspace>/.cursor/mcp.json` for one repo |
| Cline | MCP Servers → Configure MCP Servers (`cline_mcp_settings.json`) |
| Claude Desktop | `claude_desktop_config.json` (Settings → Developer → Edit Config) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Zed / Continue / any MCP host | Whatever that host calls its MCP server list — same three fields |

Restart the client afterwards. Node.js ≥ 20 must be on PATH for `npx`.

### Which tools does it expose?

Twelve, over MCP stdio: `memory_save`, `memory_search`, `memory_recall`, `memory_get`,
`memory_update`, `memory_delete`, `memory_list_namespaces`, `memory_health`, `context_save`,
`context_load`, `project_info`, and `context_archive`. Every client sees the same set. Call `memory_health` first to confirm the key works.

### Does it bloat my prompt?

No — memory is pulled, not pushed. Nothing is injected into the system prompt. The agent calls
`memory_search` only when it decides prior context is worth retrieving, and gets back a bounded
ranked set (default 10 hits, hard cap 50), so tokens are spent per-query rather than per-turn.

### How is it different from a CLAUDE.md / .cursorrules file?

A rules file is static text re-read in full every session and shared by nothing. Kireo memory MCP
is queried on demand, is written by the agent as work happens, is searchable semantically, and is
shared across projects, sessions and machines through namespaces.

### Can it index my codebase?

Yes. `npx -y -p @kireo/mcp-server kireo index ./ --repo my-app` extracts functions/classes/methods
into a `code-<repo>` namespace that `memory_search` can reach. Indexing is incremental — re-runs
only send changed files, and the server dedupes identical symbols, so retrying is safe.

### Is my code uploaded?

The compact command uploads the conversation summary you ask it to archive. `context_save`
uploads a handoff; `memory_save` uploads supplied content; `kireo index` uploads extracted code
symbols. These actions send their content to your Kireo account. Set `KIREO_TELEMETRY=0` to also drop the `X-Device-Id` header.

### What does it cost?

Free beta. Sign up at <https://app.kireo.app>, create a key, done — no card.

<!-- KIREO:ANSWER-BLOCK:END -->

## Conversation compression (0.3.0)

The Kireo plugin adds `/kireo:compact` in Claude Code and `$kireo-compact` in Codex:
it summarizes the visible conversation, writes `<directory-name>.md`, and uploads
it to your Kireo account with offline retry and versioned file metadata.
[Install the plugin](https://github.com/wang1051992187/kireo-mcp-server/tree/main/plugins/kireo).

The MCP now also provides `project_info`, `context_save`, `context_load`, and
`context_archive`, alongside the eight general memory tools below.

## Quickstart

1. Get an API key at <https://app.kireo.app/app/api-keys> (`ki_sk_…`).
2. Add this MCP server to your host. **Claude Code** — run:

```bash
claude mcp add kireo --scope user --env KIREO_API_KEY=ki_sk_xxx -- npx -y --package=@kireo/mcp-server kireo-mcp
```

   Two details in that line are load-bearing, both verified against claude 2.1.220 and npm 11 on 2026-08-03:

   - **`--package=@kireo/mcp-server kireo-mcp`, not `@kireo/mcp-server`.** This package ships two binaries (`kireo`, `kireo-mcp`), neither named after the package, so `npx -y @kireo/mcp-server` cannot pick one and fails with `could not determine executable to run`.
   - **`--package=`, not the short `-p`.** A bare `-p` after `--` gets swallowed by the `claude mcp add` option parser, which then rejects its own flag: `claude mcp add kireo --env … -- npx -y -p @kireo/mcp-server kireo-mcp` errors with `unknown option '--env'`. The long form parses cleanly.

   Drop `--scope user` if you only want it in the current project. Alternatively, check a project-scoped `.mcp.json` into your repo root with the same shape (inside JSON `args` the short `-p` is fine — it goes straight to npx and never reaches the claude parser):

```jsonc
// .mcp.json (project root)
{
  "mcpServers": {
    "kireo": {
      "command": "npx",
      "args": ["-y", "--package=@kireo/mcp-server", "kireo-mcp"],
      "env": { "KIREO_API_KEY": "ki_sk_xxx" }
    }
  }
}
```

3. Restart the host. You now have 12 tools available to the AI:

| Tool | Purpose |
|---|---|
| `memory_save` | Persist a long-term memory |
| `memory_search` | Hybrid semantic + keyword search |
| `memory_recall` | Replay recent/important memories |
| `memory_get` | Fetch by id |
| `memory_update` | Patch fields |
| `memory_delete` | Soft/hard delete |
| `memory_list_namespaces` | Enumerate namespaces |
| `memory_health` | Probe service |

## Configuration

Sources are merged in order: **CLI args > env > `~/.kireo/config.json`**.

| ENV / CLI | Default | Description |
|---|---|---|
| `KIREO_API_KEY` / `--api-key` | _required_ | Bearer token (`ki_sk_…`). |
| `KIREO_API_URL` / `--api-url` | `https://api.kireo.app` | Override for self-host. |
| `KIREO_REQUEST_TIMEOUT_MS` / `--timeout` | `60000` | Per-request timeout in ms, max `300000` (env alias: `KIREO_TIMEOUT_MS`). |
| `KIREO_RETRY_MAX_ATTEMPTS` | `3` | 5xx/429 retries (alias: `KIREO_RETRY_MAX`). |
| `KIREO_RETRY_BASE_MS` | `200` | Exponential backoff base. |
| `KIREO_TELEMETRY` | `1` | Set to `0` to disable device-id header. |
| `KIREO_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent`. |
| `KIREO_PROXY_URL` | _none_ | HTTP(S) proxy. |
| `KIREO_ACCEPT_LANGUAGE` | `en` | Locale for error hints. |

Logs land in `~/.kireo/logs/` on all platforms (macOS, Linux, Windows).

## Indexing local code

Index a repository's symbols (functions / classes / methods) into a
`code-<repo>` namespace so the AI can recall them via `memory_search`:

```bash
export KIREO_API_KEY=ki_sk_xxx
npx -y -p @kireo/mcp-server kireo index ./ --repo my-app
```

Indexing is incremental — only changed files are re-sent on subsequent runs.

| Flag | Default | Description |
|---|---|---|
| `--repo <name>` | directory basename | Repo name → `code-<name>` namespace. |
| `--batch-size <n>` | `100` | Symbols per upload batch (`1..100`). Lower it if a batch times out. |
| `--timeout <ms>` | `60000` | Per-request timeout (max `300000`). |
| `--api-key` / `--api-url` / `--namespace` / `--log-level` / `--no-telemetry` | — | Same as the config table above; CLI flags override env. |

Run `kireo --help` for the full usage text. `--help` and `--version` never touch
the network or the filesystem and don't require an API key. If a batch upload
times out, re-running the same command is safe: the server dedupes identical
symbols, so retries won't create duplicates.

## Host setup

- [Claude Code](./docs/host-claude-code.md)
- [Cursor](./docs/host-cursor.md)
- [Windsurf](./docs/host-windsurf.md)

## Privacy

Set `KIREO_TELEMETRY=0` to drop the `X-Device-Id` header. We never read your code; only the explicit content you pass to `memory_save` reaches the API.

## Troubleshooting

- `AUTH_INVALID_KEY` → rotate your key at <https://app.kireo.app/app/api-keys>.
- `QUOTA_EXCEEDED` → upgrade or wait for next billing cycle.
- Tools missing in your host → run `npx @modelcontextprotocol/inspector node $(npm root -g)/@kireo/mcp-server/bin/kireo-mcp.cjs` to verify locally.

## License

MIT
