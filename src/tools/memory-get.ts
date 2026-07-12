import { z } from 'zod';
import type { MemoryRecord } from '../rest/types.js';
import { type ToolContext, defineTool, toJsonResult } from './shared.js';

const GetInput = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^mem_[A-Za-z0-9]+$/)
      .describe('The memory id (looks like "mem_01HXVK...").'),
  })
  .strict();

type GetInputT = z.infer<typeof GetInput>;

export const memoryGetTool = defineTool<GetInputT>({
  name: 'memory_get',
  description: [
    'Fetch a single memory by id.',
    '',
    'When to use:',
    '- You already have a memory id from a previous memory_search / memory_recall / memory_save call.',
    '- The user references "that memory you saved" and you stored the id.',
    '',
    'When NOT to use:',
    '- You only have a vague query — use memory_search or memory_recall instead.',
  ].join('\n'),
  schema: GetInput,
  handler: async (input, ctx: ToolContext) => {
    const record = await ctx.rest.request<MemoryRecord>({
      method: 'GET',
      path: `/v1/memories/${encodeURIComponent(input.id)}`,
    });
    return toJsonResult(record);
  },
});
