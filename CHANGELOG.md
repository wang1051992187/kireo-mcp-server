# Changelog

All notable changes to `@kireo/mcp-server` will be documented in this file.

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
