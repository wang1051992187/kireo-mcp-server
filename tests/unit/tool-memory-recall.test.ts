import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { RestClient } from '../../src/rest/client.js';
import { memoryRecallTool } from '../../src/tools/memory-recall.js';

const ctxWith = (request: unknown) => ({
  rest: { request } as unknown as RestClient,
  logger: pino({ level: 'silent' }),
});

const row = (id: string, importance: number, occurred_at: string) => ({
  id,
  content: id,
  type: 'fact',
  namespace: 'default',
  entities: [],
  tags: [],
  importance,
  occurred_at,
  created_at: occurred_at,
  updated_at: occurred_at,
  deleted_at: null,
  schema_version: '1.0',
});

describe('memory_recall tool', () => {
  it('GET /v1/memories (query-less) with namespace + limit', async () => {
    const request = vi.fn(async (_opts: unknown) => ({
      items: [row('mem_a', 0.4, '2026-01-02T00:00:00Z'), row('mem_b', 0.9, '2026-01-01T00:00:00Z')],
      next_cursor: null,
    }));
    const res = await memoryRecallTool.handler(
      { namespace: 'default', limit: 10, order: 'recency' } as Parameters<
        typeof memoryRecallTool.handler
      >[0],
      ctxWith(request),
    );
    const call = request.mock.calls[0]?.[0] as { method: string; path: string } | undefined;
    expect(call?.method).toBe('GET');
    expect(call?.path).toContain('/v1/memories');
    expect(call?.path).toContain('namespace=default');
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Recalled 2');
  });

  it('order=importance sorts by importance desc', async () => {
    const request = vi.fn(async () => ({
      items: [row('lo', 0.3, '2026-01-02T00:00:00Z'), row('hi', 0.95, '2026-01-01T00:00:00Z')],
      next_cursor: null,
    }));
    const res = await memoryRecallTool.handler(
      { namespace: 'default', limit: 10, order: 'importance' } as Parameters<
        typeof memoryRecallTool.handler
      >[0],
      ctxWith(request),
    );
    const text = (res.content[0] as { text: string }).text;
    const jsonPart = (text.split('\n\n```json\n')[1] ?? '').replace(/\n```$/, '');
    const payload = JSON.parse(jsonPart) as { memories: Array<{ id: string }> };
    expect(payload.memories[0]?.id).toBe('hi');
  });

  it('recency + since nulls the cursor once the page crosses the since boundary', async () => {
    // Page is occurred_at-descending; oldest item (2026-01-01) is older than
    // `since` (2026-01-15), so no newer matches exist beyond this page — the
    // tool must NOT return a cursor (which would send the caller paging through
    // strictly-older, all-non-matching memories).
    const request = vi.fn(async () => ({
      items: [row('new', 0.5, '2026-02-01T00:00:00Z'), row('old', 0.5, '2026-01-01T00:00:00Z')],
      next_cursor: 'more',
    }));
    const res = await memoryRecallTool.handler(
      { namespace: 'default', limit: 10, order: 'recency', since: '2026-01-15T00:00:00Z' } as Parameters<
        typeof memoryRecallTool.handler
      >[0],
      ctxWith(request),
    );
    const text = (res.content[0] as { text: string }).text;
    const jsonPart = (text.split('\n\n```json\n')[1] ?? '').replace(/\n```$/, '');
    const payload = JSON.parse(jsonPart) as {
      memories: Array<{ id: string }>;
      next_cursor: string | null;
    };
    expect(payload.memories.map((m) => m.id)).toEqual(['new']);
    expect(payload.next_cursor).toBeNull();
  });

  it('recency + since keeps the cursor when the whole page still matches', async () => {
    // Every item is newer than `since`, so more matches may exist → keep cursor.
    const request = vi.fn(async () => ({
      items: [row('a', 0.5, '2026-02-02T00:00:00Z'), row('b', 0.5, '2026-02-01T00:00:00Z')],
      next_cursor: 'more',
    }));
    const res = await memoryRecallTool.handler(
      { namespace: 'default', limit: 10, order: 'recency', since: '2026-01-15T00:00:00Z' } as Parameters<
        typeof memoryRecallTool.handler
      >[0],
      ctxWith(request),
    );
    const text = (res.content[0] as { text: string }).text;
    const jsonPart = (text.split('\n\n```json\n')[1] ?? '').replace(/\n```$/, '');
    const payload = JSON.parse(jsonPart) as { next_cursor: string | null };
    expect(payload.next_cursor).toBe('more');
  });

  it('since matches across timestamp precision (…00Z vs …00.000Z is the same instant)', async () => {
    // A memory stamped with millisecond precision must NOT be dropped when the
    // caller passes the identical instant without milliseconds. Raw ISO-string
    // comparison would order "…00.000Z" < "…00Z" ('.' < 'Z') and wrongly
    // exclude it / null the cursor; epoch comparison treats them as equal.
    const request = vi.fn(async () => ({
      items: [
        row('ms', 0.5, '2026-02-01T00:00:00.000Z'),
        row('older', 0.5, '2026-01-01T00:00:00.000Z'),
      ],
      next_cursor: 'more',
    }));
    const res = await memoryRecallTool.handler(
      { namespace: 'default', limit: 10, order: 'recency', since: '2026-02-01T00:00:00Z' } as Parameters<
        typeof memoryRecallTool.handler
      >[0],
      ctxWith(request),
    );
    const text = (res.content[0] as { text: string }).text;
    const jsonPart = (text.split('\n\n```json\n')[1] ?? '').replace(/\n```$/, '');
    const payload = JSON.parse(jsonPart) as {
      memories: Array<{ id: string }>;
      next_cursor: string | null;
    };
    // 'ms' is exactly at `since` → included; 'older' filtered; cursor nulled
    // because the page's oldest item is older than since.
    expect(payload.memories.map((m) => m.id)).toEqual(['ms']);
    expect(payload.next_cursor).toBeNull();
  });

  it('order=importance scans later pages before sorting globally', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        items: [row('page1', 0.3, '2026-01-02T00:00:00Z')],
        next_cursor: 'next',
      })
      .mockResolvedValueOnce({
        items: [row('page2-best', 0.99, '2026-01-01T00:00:00Z')],
        next_cursor: null,
      });
    const res = await memoryRecallTool.handler(
      { namespace: 'default', limit: 1, order: 'importance' } as Parameters<
        typeof memoryRecallTool.handler
      >[0],
      ctxWith(request),
    );
    const text = (res.content[0] as { text: string }).text;
    const jsonPart = (text.split('\n\n```json\n')[1] ?? '').replace(/\n```$/, '');
    const payload = JSON.parse(jsonPart) as {
      memories: Array<{ id: string }>;
      next_cursor: string | null;
    };
    expect(payload.memories[0]?.id).toBe('page2-best');
    expect(payload.next_cursor).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
