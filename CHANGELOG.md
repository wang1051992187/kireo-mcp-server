# Changelog

All notable changes to `@kireo/mcp-server` will be documented in this file.

## 0.3.0 — 2026-09-13

- Add `context_archive`: upload a host-compressed conversation as a directory-named Markdown archive, with local versioned files, lossless chunking, redaction and a retry outbox
- Add Claude Code `/kireo:compact` and Codex `$kireo-compact` plugin entries, pinned to this MCP release
- Ship Context Relay tools: `project_info`, `context_save`, `context_load`, with evidence checks, project identity, cross-project summaries and offline replay
- Ship `doctor`, `resume`, project migration and historical transcript import commands
- Improve code indexing freshness, subdirectory handling, privacy switches and incomplete batch acknowledgement handling

## 0.2.2 — 2026-08-02

Docs and packaging only — **no runtime changes**. The published code is byte-identical to 0.2.1.

- docs: the README now opens with a direct-answer block — what Kireo memory MCP is, and a
  copy-paste server entry for Claude Code, Cursor, Cline, Claude Desktop, Windsurf and any other
  MCP host, with the file each client expects it in. It also answers, in the README itself, the
  questions people otherwise have to dig for: which eight tools ship, why memory is pulled rather
  than injected into every prompt, how this differs from a `CLAUDE.md` / `.cursorrules` file,
  whether `kireo index` uploads your code, and what it costs.
- chore: the public mirror repo gains `glama.json` (declares the maintainer so the Glama listing
  can be claimed), a prepared `smithery.yaml` (not submitted yet), and a tag-triggered
  `publish-mcp.yml` that publishes to the official MCP Registry over GitHub OIDC — no more
  five-minute device-code tokens.
- chore: the private→public mirror sync is now a script (`scripts/promo/sync-mcp-mirror.sh`)
  instead of remembered steps. It vendors `@kireo/shared`, keeps `server.json` in lockstep with
  the version actually on npm, and is idempotent — re-running it when nothing changed does nothing.

The Glama badge is intentionally not in the README yet: the listing has to be claimed first, and a
badge for an unclaimed listing renders as a broken image.

## 0.2.1 — 2026-07-12

- chore: correct repository metadata; add `mcpName` for the official MCP Registry; expand keywords. No runtime changes.

## 0.2.0

- **`kireo index` no longer times out on real repos (BUG-001).** The default
  request timeout is now `60000` ms (was `10000`) and the hard cap is `300000` ms
  (was `60000`), so a full 100-symbol embedding batch survives out of the box.
  New `kireo index` flags: `--timeout <ms>` and `--batch-size <n>` (1..100,
  default 100). `--timeout` is also accepted as an alias of `--timeout-ms`.
- **`kireo --help` / `kireo index --help` are now safe and useful (BUG-004).**
  Help and `--version` are handled before any config validation, network, or
  filesystem access — they print usage to stdout, require no API key, and have
  zero side effects (previously `index --help` silently indexed the current
  directory). Unknown `kireo index` flags now error out with exit code 1 and a
  usage hint instead of falling through to "index the cwd".
- **Code memories no longer duplicate the signature/docstring (BUG-007).** The
  assembled `content` prepends the signature or docstring only when it is not
  already present in the extracted source, so each appears exactly once instead
  of `def inc(self): def inc(self): …`.
- **Clearer, accurate batch-failure logging (BUG-002, client side).** On a
  timeout/abort the log now reports `batchesConfirmed` / `batchesAttempted` /
  `batchesTotal` (no more misleading `sent: 0`) and explains that the in-flight
  batch may already be committed server-side and that re-running is safe because
  the server now dedupes identical symbols by `(namespace, content_hash)`.

## 0.1.1

- Fix error-message docs link (`docs.kireo.ai` → `docs.kireo.app`).

## 0.1.0

First public release: MCP server + `kireo` / `kireo-mcp` CLIs for long-term
memory and local code indexing.
