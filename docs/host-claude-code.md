# Claude Code

Verified against `claude` 2.1.231 on 2026-08-31.

## Option A (recommended): install the plugin

The plugin brings the MCP server **and** the `/kireo:save` / `/kireo:resume`
commands, and prompts for the API key at install time.

```bash
# From a clone of this repo (the marketplace manifest lives at its root):
claude plugin marketplace add /path/to/kireo
claude plugin install kireo@kireo --config KIREO_API_KEY=ki_sk_xxx
```

`claude plugin details kireo@kireo` should list two skills (`save`, `resume`)
and one MCP server; `claude mcp list` should show
`plugin:kireo:kireo … ✔ Connected`. Both were verified this way on 2026-08-31.

Once the marketplace is published, `claude plugin marketplace add <owner>/<repo>`
takes the same GitHub shorthand — that form has NOT been exercised yet, so if it
misbehaves, the local-directory form above is the one known to work.

## Option B: MCP server only

```bash
claude mcp add kireo --scope user --env KIREO_API_KEY=ki_sk_xxx \
  -- npx -y --package=@kireo/mcp-server kireo-mcp
```

Two details in that line are load-bearing:

- **`--package=@kireo/mcp-server kireo-mcp`, not `@kireo/mcp-server`.** The
  package ships two binaries (`kireo`, `kireo-mcp`) and neither is named after
  the package, so a bare `npx -y @kireo/mcp-server` fails with
  `could not determine executable to run`.
- **`--package=`, not the short `-p`.** A bare `-p` after `--` is swallowed by
  the `claude mcp add` option parser, which then rejects its own flag with
  `unknown option '--env'`.

Drop `--scope user` to scope it to the current project only.

> There is no `~/.claude/mcp.json`. User-scope servers live in `~/.claude.json`,
> which `claude mcp add` maintains for you — edit it by hand only as a last
> resort.

## Per-project config

Check a `.mcp.json` into the repo root. Inside JSON `args` the short `-p` would
be fine (it goes straight to npx), but keep the long form so the two spellings
never diverge:

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

## Verifying

```bash
claude mcp list                              # expect: kireo … ✔ Connected
npx -y --package=@kireo/mcp-server kireo doctor
```

`kireo doctor` is the one that answers "why is nothing being saved": it checks
the key, the quota, the resolved project identity, the local outbox, the code
index anchor, the privacy kill switch, and — the part nothing else covers —
whether this version can still parse Claude Code's on-disk transcripts. See
[`docs/RELAY.md`](../../../docs/RELAY.md).

```bash
# Raw protocol check, if you suspect the process itself:
npx @modelcontextprotocol/inspector --cli --method tools/list \
  npx -y --package=@kireo/mcp-server kireo-mcp
```
