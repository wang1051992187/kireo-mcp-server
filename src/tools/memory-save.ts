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

const SaveInput = z
  .object({
    content: z
      .string()
      .min(1)
      .max(8000)
      .describe(
        'The memory text to persist. Be concrete and self-contained — future-you should understand it without surrounding chat.',
      ),
    type: z
      .enum(MEMORY_TYPES)
      .default('fact')
      .describe(
        '"preference" = user likes/dislikes, "decision" = chosen approach, "fact" = stable truth, "event" = time-bounded happening, "goal" = intent, "insight" = derived learning, "relationship" = link between entities.',
      ),
    namespace: namespaceInput
      .default('default')
      .describe(
        'Logical bucket (e.g. project name). Use "default" unless the user has multiple isolated contexts.',
      ),
    entities: z
      .array(entityInput)
      .max(20)
      .optional()
      .describe('Named entities mentioned (people, products, repos). Helps later retrieval.'),
    tags: z.array(tagInput).max(10).optional(),
    importance: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('0..1 priority hint. Defaults to 0.5 server-side.'),
    occurred_at: z
      .string()
      .datetime()
      .optional()
      .describe('ISO-8601 timestamp when the memory factually happened. Defaults to server now().'),
    metadata: metadataInput.optional(),
  })
  .strict();

type SaveInputT = z.infer<typeof SaveInput>;

export const memorySaveTool = defineTool<SaveInputT>({
  name: 'memory_save',
  description: [
    'Persist a long-term memory for the current user.',
    '',
    'When to use:',
    '- The user states a preference, decision, fact, plan, or goal that should outlive this chat.',
    '- You learn a stable property of the user, their project, or their tooling.',
    '- The user explicitly says "remember", "记住", "save this".',
    '',
    'When NOT to use:',
    '- Ephemeral chat turns ("ok", "thanks").',
    '- Sensitive secrets (API keys, passwords) — refuse and warn the user.',
    '- Information you can re-derive from the codebase on demand.',
    '',
    'Returns: { id, created_at, schema_version, embedding_status } — use memory_get for the full record.',
  ].join('\n'),
  schema: SaveInput,
  handler: async (input, ctx: ToolContext) => {
    // POST /v1/memories returns a minimal envelope, NOT the full MemoryRecord —
    // typing it as MemoryRecord would hand the model an object whose
    // content/namespace/tags fields are silently undefined.
    const record = await ctx.rest.request<
      Pick<MemoryRecord, 'id' | 'created_at' | 'embedding_status'> & { schema_version: string }
    >({
      method: 'POST',
      path: '/v1/memories',
      body: input,
    });
    // The POST envelope omits namespace; use the input value for the summary.
    const ns = input.namespace ?? 'default';
    ctx.logger.info({ memory_id: record.id, namespace: ns }, 'tool.memory_save.ok');
    return toJsonResult(record, `Saved memory ${record.id} in namespace "${ns}".`);
  },
});
