import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { RestClient } from '../../src/rest/client.js';
import { memoryHealthTool } from '../../src/tools/memory-health.js';

describe('memory_health tool', () => {
  it('远端 ok 时返回 local + remote', async () => {
    // 真实 GET /v1/health 返回 { ok: boolean }，status 由工具自行推导
    const request = vi.fn(async () => ({ ok: true }));
    const ctx = {
      rest: { request } as unknown as RestClient,
      logger: pino({ level: 'silent' }),
    };
    const res = await memoryHealthTool.handler(
      {} as Parameters<typeof memoryHealthTool.handler>[0],
      ctx,
    );
    expect(request).toHaveBeenCalledWith({ method: 'GET', path: '/v1/health' });
    const txt = (res.content[0] as { text: string }).text;
    expect(txt).toContain('"status": "ok"');
    expect(txt).toContain('node_version');
  });

  it('远端失败时返回 down 而非抛出', async () => {
    const request = vi.fn(async () => {
      throw new Error('network');
    });
    const ctx = {
      rest: { request } as unknown as RestClient,
      logger: pino({ level: 'silent' }),
    };
    const res = await memoryHealthTool.handler(
      {} as Parameters<typeof memoryHealthTool.handler>[0],
      ctx,
    );
    const txt = (res.content[0] as { text: string }).text;
    expect(txt).toContain('"status": "down"');
  });
});
