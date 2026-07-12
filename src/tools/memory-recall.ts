import { z } from 'zod';
import type { MemoryListResponse, MemoryRecord } from '../rest/types.js';
import { namespaceInput } from './input-limits.js';
import { type ToolContext, defineTool, toJsonResult } from './shared.js';

const RecallInput = z
  .object({
    namespace: namespaceInput.default('default'),
    cursor: z
      .string()
      .optional()
      .describe('Opaque cursor from a previous recall response, for pagination.'),
    limit: z.number().int().min(1).max(50).default(20),
    order: z.enum(['recency', 'importance']).default('recency'),
    since: z
      .string()
      .datetime()
      .optional()
      .describe('Only return memories with occurred_at >= since.'),
  })
  .strict();

type RecallInputT = z.infer<typeof RecallInput>;

export const memoryRecallTool = defineTool<RecallInputT>({
  name: 'memory_recall',
  description: [
    'Replay recent or important memories from a namespace, without a query.',
    '',
    'When to use:',
    '- At the start of a new chat — to load recent context.',
    '- The user says "what have we been working on" / "remind me".',
    '- You want a chronological feed rather than a search match.',
    '',
    'When NOT to use:',
    '- The user has a specific question → use memory_search.',
    '- You already have the id → use memory_get.',
  ].join('\n'),
  schema: RecallInput,
  handler: async (input, ctx: ToolContext) => {
    // `/v1/recall` requires a query and is strict; recall is "replay without a
    // query", so we use the query-less list endpoint and order client-side.
    const fetchPage = async (
      cursor: string | undefined,
      limit: number,
    ): Promise<MemoryListResponse> => {
      const params = new URLSearchParams();
      params.set('namespace', input.namespace);
      params.set('limit', String(limit));
      if (cursor) params.set('cursor', cursor);
      return ctx.rest.request<MemoryListResponse>({
        method: 'GET',
        path: `/v1/memories?${params.toString()}`,
      });
    };

    // The list API only orders by recency, so order='importance' has to scan
    // and sort client-side. Cap the scan: draining an entire large namespace on
    // every call is quadratic backend load and unbounded round-trips. We sort
    // the most-recent IMPORTANCE_SCAN_MAX rows — a recency-weighted importance
    // ranking — rather than the whole history.
    const IMPORTANCE_SCAN_MAX = 1000;
    const first = await fetchPage(input.cursor, input.order === 'importance' ? 200 : input.limit);
    let memories: MemoryRecord[] = first.items;
    let nextCursor = first.next_cursor;
    if (input.order === 'importance') {
      const seen = new Set<string>();
      while (nextCursor && !seen.has(nextCursor) && memories.length < IMPORTANCE_SCAN_MAX) {
        seen.add(nextCursor);
        const page = await fetchPage(nextCursor, 200);
        memories.push(...page.items);
        nextCursor = page.next_cursor;
      }
    }
    if (input.since) {
      // Compare as epoch millis, not raw ISO strings: occurred_at and `since`
      // can differ in fractional-second precision (…00Z vs …00.000Z) or use a
      // numeric offset instead of Z, all of which break lexicographic ordering
      // even though the instants are equal/ordered.
      const sinceMs = Date.parse(input.since);
      // The list endpoint is occurred_at-descending, so once a fetched page's
      // OLDEST item is older than `since`, every later (older) page is entirely
      // non-matching. Stop advertising a cursor — otherwise a `since` caller
      // gets an empty/short page plus a cursor and wastes round-trips paging
      // through progressively older, all-non-matching memories. (The importance
      // path already scanned every page and returns a null cursor below.)
      if (input.order === 'recency') {
        const oldest = first.items.at(-1);
        if (oldest && Date.parse(oldest.occurred_at) < sinceMs) nextCursor = null;
      }
      memories = memories.filter((m) => Date.parse(m.occurred_at) >= sinceMs);
    }
    if (input.order === 'importance') {
      memories = [...memories].sort((a, b) => b.importance - a.importance);
    }
    memories = memories.slice(0, input.limit);
    return toJsonResult(
      { memories, next_cursor: input.order === 'importance' ? null : nextCursor },
      `Recalled ${memories.length} ${memories.length === 1 ? 'memory' : 'memories'} from namespace "${input.namespace}" ordered by ${input.order}.`,
    );
  },
});
