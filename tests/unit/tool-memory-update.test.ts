import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { RestClient } from '../../src/rest/client.js';
import { memoryUpdateTool } from '../../src/tools/memory-update.js';

describe('memory_update tool', () => {
  it('PATCH /v1/memories/:id 且 body 不含 id', async () => {
    const request = vi.fn(async () => ({
      id: 'mem_abc',
      namespace: 'default',
      content: 'new',
      type: 'fact',
      entities: [],
      tags: [],
      importance: 0.5,
      occurred_at: '2026-05-26T00:00:00Z',
      created_at: '2026-05-26T00:00:00Z',
      updated_at: '2026-05-26T00:00:00Z',
      deleted_at: null,
      schema_version: '1.0',
    }));
    const ctx = {
      rest: { request } as unknown as RestClient,
      logger: pino({ level: 'silent' }),
    };
    await memoryUpdateTool.handler(
      { id: 'mem_abc', content: 'new' } as Parameters<typeof memoryUpdateTool.handler>[0],
      ctx,
    );
    expect(request).toHaveBeenCalledWith({
      method: 'PATCH',
      path: '/v1/memories/mem_abc',
      body: { content: 'new' },
    });
  });

  it('只传 id 时拒绝', () => {
    const r = memoryUpdateTool.zod.safeParse({ id: 'mem_abc' });
    expect(r.success).toBe(false);
  });

  it('id regex 验证', () => {
    const r1 = memoryUpdateTool.zod.safeParse({ id: 'mem_abc', content: 'x' });
    expect(r1.success).toBe(true);

    const r2 = memoryUpdateTool.zod.safeParse({ id: 'invalid_id', content: 'x' });
    expect(r2.success).toBe(false);
  });

  it('content 超长被拒绝', () => {
    const r = memoryUpdateTool.zod.safeParse({
      id: 'mem_abc',
      content: 'x'.repeat(9000),
    });
    expect(r.success).toBe(false);
  });

  it('tags 数组长度限制', () => {
    const r = memoryUpdateTool.zod.safeParse({
      id: 'mem_abc',
      tags: Array.from({ length: 21 }, (_, i) => `tag${i}`),
    });
    expect(r.success).toBe(false);
  });

  it('importance 范围 0-1', () => {
    const r1 = memoryUpdateTool.zod.safeParse({
      id: 'mem_abc',
      importance: 0.5,
    });
    expect(r1.success).toBe(true);

    const r2 = memoryUpdateTool.zod.safeParse({
      id: 'mem_abc',
      importance: 1.5,
    });
    expect(r2.success).toBe(false);
  });
});
