# Claude Code

## Global config

Edit `~/.claude/mcp.json`:

```jsonc
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

## Per-project config

Add a `.mcp.json` at the repo root with the same shape — Claude Code merges it on top of global config.

## Verifying

```bash
npx @modelcontextprotocol/inspector --cli --method tools/list npx -y @kireo/mcp-server
```
