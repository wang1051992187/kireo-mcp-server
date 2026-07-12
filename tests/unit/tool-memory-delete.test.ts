import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { RestClient } from '../../src/rest/client.js';
import { memoryDeleteTool } from '../../src/tools/memory-delete.js';

describe('memory_delete tool', () => {
  it('默认软删除', async () => {
    const request = vi.fn(async () => undefined);
    const ctx = {
      rest: { request } as unknown as RestClient,
      logger: pino({ level: 'silent' }),
    };
    const parsed = memoryDeleteTool.zod.parse({ id: 'mem_abc' });
    const res = await memoryDeleteTool.handler(
      parsed as Parameters<typeof memoryDeleteTool.handler>[0],
      ctx,
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'DELETE',
        path: '/v1/memories/mem_abc',
      }),
    );
    const callArg = (request.mock.calls as unknown[][])?.[0]?.[0] as unknown;
    expect(callArg).toBeDefined();
    expect((callArg as Record<string, unknown>).query).toBeUndefined();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Soft-deleted');
  });

  it('hard=true 仍是软删除，且如实告知（API 无硬删除）', async () => {
    const request = vi.fn(async () => undefined);
    const ctx = {
      rest: { request } as unknown as RestClient,
      logger: pino({ level: 'silent' }),
    };
    const res = await memoryDeleteTool.handler(
      { id: 'mem_abc', hard: true } as Parameters<typeof memoryDeleteTool.handler>[0],
      ctx,
    );
    // API 只实现软删除：不应发送 hard query，也绝不能谎称"永久删除"
    expect(request).toHaveBeenCalledWith({
      method: 'DELETE',
      path: '/v1/memories/mem_abc',
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Soft-deleted');
    expect(text).toContain('not supported');
    expect(text).not.toContain('Permanently deleted');
  });

  it('id regex 验证', () => {
    const r1 = memoryDeleteTool.zod.safeParse({ id: 'mem_xyz' });
    expect(r1.success).toBe(true);

    const r2 = memoryDeleteTool.zod.safeParse({ id: 'invalid_id' });
    expect(r2.success).toBe(false);
  });

  it('hard 默认为 false', () => {
    const r = memoryDeleteTool.zod.parse({ id: 'mem_abc' });
    expect(r.hard).toBe(false);
  });
});
