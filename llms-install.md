# Installing Kireo MCP server (for AI agents)

1. The user needs an API key. Direct them to
   https://app.kireo.app/app/api-keys (free signup). Keys look like
   `ki_sk_…`. Never ask the user to paste the key into chat if the platform
   supports secret inputs.
2. Add this server to the MCP config of the current client:

```json
{
  "mcpServers": {
    "kireo": {
      "command": "npx",
      "args": ["-y", "--package=@kireo/mcp-server", "kireo-mcp"],
      "env": { "KIREO_API_KEY": "<user's key>" }
    }
  }
}
```

3. Restart the client. Verify by calling `memory_health`; it should return an
   ok status. A 401 response means the key is wrong or missing.
4. No other setup is required. Node.js >= 20 must be available for `npx`.
