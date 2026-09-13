# Kireo conversation memory plugin

Compress the visible conversation into a Markdown memory archive, named after
the current working directory, and upload it to your Kireo account.

## Install

Requires Node.js 20 or later and a Kireo API key. Configure `KIREO_API_KEY` in
the host environment, or set `api_key` in `~/.kireo/config.json`. For a self-hosted
platform, also set `KIREO_API_URL` or `api_url` in that configuration file.
Never put a key in a plugin manifest or commit it to Git.

Claude Code:

```text
/plugin marketplace add wang1051992187/kireo-mcp-server
/plugin install kireo@kireo
```

Codex: add this repository as a plugin marketplace and install its `kireo`
plugin. The Codex marketplace manifest is `.agents/plugins/marketplace.json`
and its source is `plugins/kireo`. The marketplace's name is `personal`.
Enable the plugin in a conversation that contains the work you want to archive.

## Use

- Claude Code: `/kireo:compact`
- Codex: `$kireo-compact`
- Natural language: “Compress our recent conversation and upload it as a file named after this directory”

The host model summarizes the conversation; no second model API key is needed.
The plugin retains requirements, decisions and reasons, constraints, results,
corrections and unfinished work. Missing older context is disclosed instead of
invented. Ask for “preview only” to inspect the exact redacted payload first.

For a directory named `my-project`, the local file is
`.kireo/archives/<snapshot-sha256>/my-project.md`. The platform stores searchable
memory records with `metadata.filename` and `file_path` set to `my-project.md`.
Long documents use ordered chunks, with `snapshot_id`, `chunk_index` and
`chunk_count`. This is a Markdown archive stored as memories, not an object-store
attachment. The tool returns the dashboard URL and memory IDs.

Each physical directory has a separate project namespace, including different
worktrees and same-named directories. Moving a directory or switching devices
creates a different directory archive project. Use `/kireo:save` and
`/kireo:resume` for the existing Git-based cross-device context relay instead.

Failed uploads remain in the directory's outbox and retry on the next compact.
`outbox_pending: true` means the full upload has not been acknowledged.
`KIREO_DISABLED` or `.kireo/disabled` disables archiving and retry.
Stored memories follow the platform's account quota and retention rules.

Other commands: `/kireo:save` saves structured context cards;
`/kireo:resume` reloads those cards. Directory archives do not automatically
appear in resume; use the returned memory IDs or dashboard URL to read them.
