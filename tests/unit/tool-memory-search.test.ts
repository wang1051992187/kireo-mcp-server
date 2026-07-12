import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { RestClient } from '../../src/rest/client.js';
import { memorySearchTool } from '../../src/tools/memory-search.js';

describe('memory_search tool', () => {
  it('POST /v1/search and summarizes hits', async () => {
    const request = vi.fn(async () => ({
      hits: [
        {
          id: 'mem_1',
          content: 'x',
          type: 'fact',
          namespace: 'default',
          tags: [],
          importance: 0.5,
          occurred_at: '2026-01-01T00:00:00Z',
          created_at: '2026-01-01T00:00:00Z',
          score: 0.42,
        },
      ],
    }));
    const ctx = { rest: { request } as unknown as RestClient, logger: pino({ level: 'silent' }) };
    const res = await memorySearchTool.handler(
      { query: 'tailwind', namespace: 'default', limit: 5 } as Parameters<
        typeof memorySearchTool.handler
      >[0],
      ctx,
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/v1/search',
        body: expect.objectContaining({ query: 'tailwind' }),
      }),
    );
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Found 1');
  });

  it('limit 上限 50', () => {
    const r = memorySearchTool.zod.safeParse({ query: 'x', limit: 100 });
    expect(r.success).toBe(false);
  });

  it('rejects misleading 0..1 min_score thresholds', () => {
    const r = memorySearchTool.zod.safeParse({ query: 'x', min_score: 0.5 });
    expect(r.success).toBe(false);
  });
});
