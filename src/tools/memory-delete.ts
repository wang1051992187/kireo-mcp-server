import { z } from 'zod';
import { type ToolContext, defineTool, toTextResult } from './shared.js';

const DeleteInput = z
  .object({
    id: z.string().regex(/^mem_[A-Za-z0-9]+$/),
    hard: z
      .boolean()
      .default(false)
      .describe(
        'Accepted for compatibility, but the API only supports soft deletes — the memory is recoverable for 30 days, then purged permanently.',
      ),
  })
  .strict();

type DeleteInputT = z.infer<typeof DeleteInput>;

export const memoryDeleteTool = defineTool<DeleteInputT>({
  name: 'memory_delete',
  description: [
    'Delete a memory. Defaults to a soft delete (30-day recovery window).',
    '',
    'When to use:',
    '- The user explicitly asks to forget something ("forget that I said …").',
    '- A memory is clearly wrong AND not worth correcting.',
    '- GDPR / privacy removal request.',
    '',
    'When NOT to use:',
    '- The memory is just outdated — prefer memory_update.',
    "- You're unsure — ask the user first.",
    '',
    'Note: deletes are always soft — the API has no immediate hard delete. Soft-deleted memories are purged permanently after the 30-day window.',
  ].join('\n'),
  schema: DeleteInput,
  handler: async (input, ctx: ToolContext) => {
    // The API only implements soft delete (DELETE /v1/memories/:id ignores any
    // hard flag). Never tell the model/user a memory was permanently erased
    // when it is still recoverable for 30 days.
    await ctx.rest.request<void>({
      method: 'DELETE',
      path: `/v1/memories/${encodeURIComponent(input.id)}`,
    });
    ctx.logger.info({ memory_id: input.id, hard: input.hard }, 'tool.memory_delete.ok');
    return toTextResult(
      input.hard
        ? `Soft-deleted memory ${input.id}. Permanent (hard) deletion is not supported by the API — the memory stays recoverable for 30 days, then is purged automatically.`
        : `Soft-deleted memory ${input.id} (recoverable for 30 days).`,
    );
  },
});
