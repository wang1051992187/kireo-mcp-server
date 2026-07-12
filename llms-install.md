# Installing Kireo MCP server (for AI agents)

1. The user needs an API key. Direct them to https://app.kireo.app/api-keys
   (free signup). Keys look like `ki_sk_…`. Never ask the user to paste the
   key into chat if your platform supports secret inputs.
2. Add to the MCP config of this client:

```json
{
  "mcpServers": {
    "kireo": {
      "command": "npx",
      "args": ["-y", "@kireo/mcp-server"],
      "env": { "KIREO_API_KEY": "<user's key>" }
    }
  }
}
```

3. Restart the client. Verify by calling the `memory_health` tool — it should
   return an ok status. If it errors with 401, the key is wrong or missing.
4. No other setup is required. Node.js >= 18 must be available for `npx`.
