import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode as McpErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config/merge.js';
import { RestApiError, toMcpError } from './lib/errors.js';
import { deviceIdOrAnon } from './observability/device-id.js';
import { createLogger } from './observability/logger.js';
import { createRestClient } from './rest/client.js';
import { ALL_TOOLS, findTool } from './tools/index.js';
import { __KIREO_MCP_VERSION__ } from './version.js';

export interface CreateServerOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}

export async function createServer(opts: CreateServerOptions = {}): Promise<Server> {
  const { config } = loadConfig({
    argv: opts.argv ?? process.argv.slice(2),
    env: opts.env ?? process.env,
  });
  const logger = createLogger(config);
  const deviceId = deviceIdOrAnon(config.telemetryEnabled);
  const rest = createRestClient({ config, deviceId, version: __KIREO_MCP_VERSION__, logger });

  const server = new Server(
    { name: 'kireo-mcp-server', version: __KIREO_MCP_VERSION__ },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const tool = findTool(name);
    if (!tool) {
      throw new McpError(McpErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    const parsed = tool.zod.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      throw new McpError(
        McpErrorCode.InvalidParams,
        `Invalid arguments for ${name}: ${parsed.error.message}`,
      );
    }
    try {
      return await tool.handler(parsed.data, { rest, logger });
    } catch (err) {
      logger.error({ tool: name, err }, 'tool.error');
      if (err instanceof McpError) throw err;
      if (err instanceof RestApiError) throw toMcpError(err);
      const message = err instanceof Error ? err.message : String(err);
      throw new McpError(McpErrorCode.InternalError, message);
    }
  });

  logger.info(
    { tools: ALL_TOOLS.length, api_url: config.apiUrl, version: __KIREO_MCP_VERSION__ },
    'server.ready',
  );
  return server;
}

export async function startServer(opts: CreateServerOptions = {}): Promise<void> {
  const server = await createServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
