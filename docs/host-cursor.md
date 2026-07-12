# Cursor

Cursor reads `~/.cursor/mcp.json` (and `<workspace>/.cursor/mcp.json` for per-repo overrides).

```jsonc
{
  "mcpServers": {
    "kireo": {
      "command": "npx",
      "args": ["-y", "@kireo/mcp-server"],
      "env": { "KIREO_API_KEY": "ki_sk_xxx" }
    }
  }
}
```

In Cursor → Settings → MCP, you should see "kireo" with 8 tools.
