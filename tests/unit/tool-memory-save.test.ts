import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { RestClient } from '../../src/rest/client.js';
import { memorySaveTool } from '../../src/tools/memory-save.js';

describe('memory_save tool', () => {
  it('inputSchema 标注 required 字段', () => {
    const s = memorySaveTool.inputSchema as {
      required?: string[];
      properties: { type: { enum: string[] } };
    };
    expect(s.required).toContain('content');
    expect(s.properties.type.enum).toContain('preference');
  });

  // The POST /v1/memories envelope is small: { id, created_at, schema_version,
  // embedding_status } — it has NO namespace, so the summary must use the input.
  it('POST /v1/memories and names the namespace from input', async () => {
    const request = vi.fn(async () => ({
      id: 'mem_abc',
      created_at: '2026-01-01T00:00:00Z',
      schema_version: '1.0',
      embedding_status: 'queued',
    }));
    const ctx = {
      rest: { request } as unknown as RestClient,
      logger: pino({ level: 'silent' }),
    };
    const res = await memorySaveTool.handler(
      { content: 'x', type: 'fact', namespace: 'work', importance: 0.6 } as Parameters<
        typeof memorySaveTool.handler
      >[0],
      ctx,
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', path: '/v1/memories' }),
    );
    expect(res.content[0]).toMatchObject({ type: 'text' });
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('Saved memory mem_abc');
    expect(text).toContain('namespace "work"');
    expect(text).not.toContain('undefined');
  });

  it('defaults the namespace label to "default" when omitted', async () => {
    const request = vi.fn(async () => ({
      id: 'mem_y',
      created_at: '2026-01-01T00:00:00Z',
      schema_version: '1.0',
      embedding_status: 'queued',
    }));
    const ctx = {
      rest: { request } as unknown as RestClient,
      logger: pino({ level: 'silent' }),
    };
    const res = await memorySaveTool.handler(
      { content: 'x', type: 'fact', importance: 0.5 } as Parameters<typeof memorySaveTool.handler>[0],
      ctx,
    );
    expect((res.content[0] as { text: string }).text).toContain('namespace "default"');
  });

  it('zod 拒绝超长 content', () => {
    const r = memorySaveTool.zod.safeParse({ content: 'x'.repeat(9000) });
    expect(r.success).toBe(false);
  });
});
