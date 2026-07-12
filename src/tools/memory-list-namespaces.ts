import { z } from 'zod';
import type { NamespaceListResponse } from '../rest/types.js';
import { type ToolContext, defineTool, toJsonResult } from './shared.js';

const ListInput = z.object({}).strict();

export const memoryListNamespacesTool = defineTool<z.infer<typeof ListInput>>({
  name: 'memory_list_namespaces',
  description: [
    'List all namespaces the current user has, with per-namespace counts.',
    '',
    'When to use:',
    '- Before deciding which namespace to save to, when the user has multiple projects.',
    '- To answer "what projects do I have memories for?".',
    '- For diagnostics.',
    '',
    'Returns: array of { name, created_at }.',
  ].join('\n'),
  schema: ListInput,
  handler: async (_input, ctx: ToolContext) => {
    const list = await ctx.rest.request<NamespaceListResponse>({
      method: 'GET',
      path: '/v1/namespaces',
    });
    return toJsonResult(
      { namespaces: list.items },
      `You have ${list.items.length} ${list.items.length === 1 ? 'namespace' : 'namespaces'}.`,
    );
  },
});
