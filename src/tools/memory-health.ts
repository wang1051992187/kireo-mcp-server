import { z } from 'zod';
import type { HealthResponse } from '../rest/types.js';
import { __KIREO_MCP_VERSION__ } from '../version.js';
import { type ToolContext, defineTool, toJsonResult } from './shared.js';

const HealthInput = z.object({}).strict();

export const memoryHealthTool = defineTool<z.infer<typeof HealthInput>>({
  name: 'memory_health',
  description: [
    'Probe the Kireo service and report local + remote health.',
    '',
    'When to use:',
    '- User reports "memory tools aren\'t working".',
    '- You hit unexplained errors and need to confirm the API is reachable.',
    '- First-time setup verification.',
    '',
    'Returns: { local: { server_version, node_version, platform }, remote: { status } }.',
  ].join('\n'),
  schema: HealthInput,
  handler: async (_input, ctx: ToolContext) => {
    // GET /v1/health returns `{ ok: boolean }` — derive a status from it
    // instead of casting to a shape the API never sends (remote.status would
    // always be undefined).
    let remote: { status: HealthResponse['status']; error?: string };
    try {
      const resp = await ctx.rest.request<{ ok: boolean }>({
        method: 'GET',
        path: '/v1/health',
      });
      remote = { status: resp.ok ? 'ok' : 'degraded' };
    } catch (err) {
      remote = { status: 'down', error: err instanceof Error ? err.message : String(err) };
    }
    const local = {
      server_version: __KIREO_MCP_VERSION__,
      node_version: process.version,
      platform: process.platform,
    };
    return toJsonResult({ local, remote });
  },
});
