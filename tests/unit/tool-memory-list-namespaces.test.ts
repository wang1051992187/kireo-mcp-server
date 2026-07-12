import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { RestClient } from '../../src/rest/client.js';
import { memoryListNamespacesTool } from '../../src/tools/memory-list-namespaces.js';

describe('memory_list_namespaces tool', () => {
  it('GET /v1/namespaces and summarizes the items', async () => {
    const request = vi.fn(async () => ({
      items: [
        { name: 'default', created_at: '2026-01-01T00:00:00Z' },
        { name: 'work', created_at: '2026-01-02T00:00:00Z' },
      ],
    }));
    const ctx = {
      rest: { request } as unknown as RestClient,
      logger: pino({ level: 'silent' }),
    };
    const res = await memoryListNamespacesTool.handler(
      {} as Parameters<typeof memoryListNamespacesTool.handler>[0],
      ctx,
    );
    expect(request).toHaveBeenCalledWith({ method: 'GET', path: '/v1/namespaces' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('You have 2 namespaces');
  });

  it('inputSchema 不接受多余字段', () => {
    const r = memoryListNamespacesTool.zod.safeParse({ extra: 1 });
    expect(r.success).toBe(false);
  });
});
