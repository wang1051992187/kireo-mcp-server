# Claude Code

## Recommended: one-liner

```bash
claude mcp add kireo --env KIREO_API_KEY=ki_sk_xxx -- npx -y @kireo/mcp-server
```

Add `--scope user` to make Kireo available in every project instead of just the current one. Restart Claude Code. Tools appear under `/mcp`.

## Alternative: project config

Check a `.mcp.json` into the repo root with the same shape — Claude Code picks it up for that project:

```jsonc
// .mcp.json (project root)
{
  "mcpServers": {
    "kireo": {
      "command": "npx",
      "args": ["-y", "@kireo/mcp-server"],
      "env": {
        "KIREO_API_KEY": "ki_sk_xxx"
      }
    }
  }
}
```

Restart Claude Code. Tools appear under `/mcp`.

## Verifying

```bash
npx @modelcontextprotocol/inspector --cli --method tools/list npx -y @kireo/mcp-server
```
