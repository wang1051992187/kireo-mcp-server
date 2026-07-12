# Windsurf (Cascade)

Add to `~/.codeium/windsurf/mcp_config.json`:

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

Restart Windsurf and check Cascade settings → MCP servers.
