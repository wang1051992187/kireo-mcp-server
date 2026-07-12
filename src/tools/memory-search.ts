import { z } from 'zod';
import type { SearchResult } from '../rest/types.js';
import { entityInput, namespaceInput, tagInput } from './input-limits.js';
import { type ToolContext, defineTool, toJsonResult } from './shared.js';

const SearchInput = z
  .object({
    query: z
      .string()
      .min(1)
      .max(2000)
      .describe('Natural language query. Hybrid (semantic + keyword) search.'),
    namespace: namespaceInput
      .optional()
      .describe(
        "Restrict to a single namespace. Omit to search across all of the user's namespaces.",
      ),
    type: z
      .array(
        z.enum([
          'fact',
          'decision',
          'preference',
          'event',
          'goal',
          'insight',
          'relationship',
          'other',
        ]),
      )
      .optional(),
    entities: z.array(entityInput).max(20).optional(),
    tags: z.array(tagInput).max(10).optional(),
    occurred_from: z.string().datetime().optional(),
    occurred_to: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(50).default(10),
    min_score: z
      .number()
      .min(0)
      .max(0.1)
      .optional()
      .describe('Optional raw RRF score threshold. Typical useful values are 0.01–0.04.'),
  })
  .strict();

type SearchInputT = z.infer<typeof SearchInput>;

export const memorySearchTool = defineTool<SearchInputT>({
  name: 'memory_search',
  description: [
    "Hybrid semantic + keyword search over the user's memories.",
    '',
    'When to use:',
    '- The user asks "do you remember…" or "what did I say about X".',
    '- Before answering project-specific questions, search for stored preferences and decisions.',
    '- You need to ground your answer in user-supplied facts.',
    '',
    'When NOT to use:',
    '- You already have the memory id → use memory_get.',
    '- You just want the most recent items in a namespace → use memory_recall.',
    '',
    'Returns: ranked list of MemoryRecord with a raw RRF relevance `score` (typically 0.01–0.04).',
  ].join('\n'),
  schema: SearchInput,
  handler: async (input, ctx: ToolContext) => {
    // The API's SearchRequestSchema is strict: filter fields must be nested
    // under `filters` (and use occurred_after/occurred_before). Sending them
    // top-level gets the whole request rejected with HTTP 400.
    const filters = {
      ...(input.namespace ? { namespace: input.namespace } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.entities ? { entities: input.entities } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.occurred_from ? { occurred_after: input.occurred_from } : {}),
      ...(input.occurred_to ? { occurred_before: input.occurred_to } : {}),
    };
    const body = {
      query: input.query,
      limit: input.limit,
      ...(Object.keys(filters).length > 0 ? { filters } : {}),
    };
    const result = await ctx.rest.request<SearchResult>({
      method: 'POST',
      path: '/v1/search',
      body,
      // Search is a read despite the POST verb — safe to retry transient
      // failures (the default for POST is non-idempotent).
      idempotent: true,
    });
    // min_score is not an API parameter — apply it client-side.
    const hits =
      input.min_score !== undefined
        ? result.hits.filter((h) => h.score >= (input.min_score as number))
        : result.hits;
    const summary = `Found ${hits.length} ${hits.length === 1 ? 'memory' : 'memories'}.`;
    return toJsonResult({ hits }, summary);
  },
});
