import { z } from 'zod';
import type { MemoryRecord, MemoryType } from '../rest/types.js';
import { entityInput, metadataInput, namespaceInput, tagInput } from './input-limits.js';
import { type ToolContext, defineTool, toJsonResult } from './shared.js';

const MEMORY_TYPES = [
  'fact',
  'decision',
  'preference',
  'event',
  'goal',
  'insight',
  'relationship',
  'other',
] as const satisfies readonly MemoryType[];

const UpdateInput = z
  .object({
    id: z.string().regex(/^mem_[A-Za-z0-9]+$/),
    content: z.string().min(1).max(8000).optional(),
    type: z.enum(MEMORY_TYPES).optional(),
    namespace: namespaceInput.optional(),
    entities: z.array(entityInput).max(20).optional(),
    tags: z.array(tagInput).max(10).optional(),
    importance: z.number().min(0).max(1).optional(),
    occurred_at: z.string().datetime().optional(),
    metadata: metadataInput.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 1, {
    message: 'Provide at least one field besides id',
  });

type UpdateInputT = z.infer<typeof UpdateInput>;

export const memoryUpdateTool = defineTool<UpdateInputT>({
  name: 'memory_update',
  description: [
    'Patch an existing memory. Only the fields you provide are changed.',
    '',
    'When to use:',
    '- The user corrects a previously stored fact ("actually, I use Tailwind v4 not v3").',
    '- You need to add tags / entities to an existing memory.',
    '- The user lowers/raises priority of a memory.',
    '',
    'When NOT to use:',
    '- The memory is wrong AND no longer relevant → use memory_delete.',
    "- You don't have the id yet → search first.",
  ].join('\n'),
  schema: UpdateInput,
  handler: async (input, ctx: ToolContext) => {
    const { id, ...body } = input;
    const record = await ctx.rest.request<MemoryRecord>({
      method: 'PATCH',
      path: `/v1/memories/${encodeURIComponent(id)}`,
      body,
    });
    ctx.logger.info({ memory_id: record.id, fields: Object.keys(body) }, 'tool.memory_update.ok');
    return toJsonResult(record, `Updated memory ${record.id}.`);
  },
});
