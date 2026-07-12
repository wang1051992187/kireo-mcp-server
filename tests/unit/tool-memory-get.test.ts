import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { RestClient } from '../../src/rest/client.js';
import { memoryGetTool } from '../../src/tools/memory-get.js';

describe('memory_get tool', () => {
  it('调用 GET /v1/memories/:id', async () => {
    const request = vi.fn(async () => ({ id: 'mem_abc', namespace: 'default' }));
    const ctx = {
      rest: { request } as unknown as RestClient,
      logger: pino({ level: 'silent' }),
    };
    await memoryGetTool.handler({ id: 'mem_abc' }, ctx);
    expect(request).toHaveBeenCalledWith({ method: 'GET', path: '/v1/memories/mem_abc' });
  });

  it('zod 拒绝非法 id', () => {
    const r = memoryGetTool.zod.safeParse({ id: 'bad id' });
    expect(r.success).toBe(false);
  });
});
