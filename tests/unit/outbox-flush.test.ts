import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushOutbox } from '../../src/context/outbox-flush.js';
import { listOutbox, writeOutbox } from '../../src/context/outbox.js';
import type { RestClient } from '../../src/rest/client.js';

/**
 * The outbox was write-only. `writeOutbox` on every save, `dropOutbox` only on
 * the SAME call's success, `listOutbox` used purely to count — nothing in the
 * codebase ever read `rec.entries` back and posted them, while spec §11, the
 * save tool's return text, the resume banner and doctor's hint all promised
 * "下次 save 与 resume 自动 flush". A user who saved offline got that promise
 * repeated forever while the entries sat on disk.
 */
let dir = '';
let auditPath = '';

const item = (content: string) => ({
  content,
  type: 'fact',
  namespace: 'ctx-a-111111',
  tags: ['kireo-ctx', 'k-constraint'],
  importance: 0.9,
  metadata: { bucket: 'constraint', files: ['src/a.ts'] },
});

const okAck = { succeeded: [{ index: 0, id: 'mem_1' }], failures: [] };

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'kireo-flush-')), 'outbox');
  auditPath = join(dir, '..', 'outbound.jsonl');
});
afterEach(() => {
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

const restOf = (request: unknown): RestClient => ({ request }) as unknown as RestClient;

describe('flushOutbox', () => {
  it('uploads a pending record and removes it from disk', async () => {
    writeOutbox(dir, {
      ts: new Date().toISOString(),
      namespace: 'ctx-a-111111',
      entries: [item('c1')],
    });
    const request = vi.fn(async () => okAck);

    const sent: { method: string; path: string }[] = [];
    const recording = vi.fn(async (req: { method: string; path: string }) => {
      sent.push({ method: req.method, path: req.path });
      return okAck;
    });
    const out = await flushOutbox(restOf(recording), dir, { auditLogPath: auditPath });

    expect(out).toMatchObject({ flushed: 1, entries: 1, remaining: 0 });
    expect(sent[0]).toEqual({ method: 'POST', path: '/v1/memories/batch' });
    expect(listOutbox(dir)).toHaveLength(0);
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps the record on disk when the upload fails, and never throws', async () => {
    writeOutbox(dir, {
      ts: new Date().toISOString(),
      namespace: 'ctx-a-111111',
      entries: [item('c1')],
    });
    const request = vi.fn(async () => {
      throw new Error('402 quota exhausted');
    });

    const out = await flushOutbox(restOf(request), dir, { auditLogPath: auditPath });

    expect(out.flushed).toBe(0);
    expect(out.remaining).toBe(1);
    expect(listOutbox(dir)).toHaveLength(1);
  });

  it('keeps a PARTIALLY failed batch so it is retried whole (the server dedupes)', async () => {
    writeOutbox(dir, {
      ts: new Date().toISOString(),
      namespace: 'ctx-a-111111',
      entries: [item('c1')],
    });
    const request = vi.fn(async () => ({
      succeeded: [],
      failures: [{ index: 0, code: 'VALIDATION_FAILED', message: 'nope' }],
    }));

    await flushOutbox(restOf(request), dir, { auditLogPath: auditPath });
    expect(listOutbox(dir)).toHaveLength(1);
  });

  it('stops at the first failing record instead of burning 20 timeouts', async () => {
    for (let i = 0; i < 3; i++) {
      writeOutbox(dir, {
        ts: new Date(Date.now() + i).toISOString(),
        namespace: 'ctx-a-111111',
        entries: [item(`c${i}`)],
      });
    }
    const request = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    await flushOutbox(restOf(request), dir, { auditLogPath: auditPath });
    expect(request).toHaveBeenCalledTimes(1);
    expect(listOutbox(dir)).toHaveLength(3);
  });

  it('replays supersede deletes only AFTER their entries land', async () => {
    writeOutbox(dir, {
      ts: new Date().toISOString(),
      namespace: 'ctx-a-111111',
      entries: [item('c1')],
      supersedes: ['old-1', 'old-2'],
    });
    const calls: string[] = [];
    const request = vi.fn(async (req: { method: string; path: string }) => {
      calls.push(`${req.method} ${req.path}`);
      return okAck;
    });

    await flushOutbox(restOf(request), dir, { auditLogPath: auditPath });

    expect(calls).toEqual([
      'POST /v1/memories/batch',
      'DELETE /v1/memories/old-1',
      'DELETE /v1/memories/old-2',
    ]);
  });

  it('does NOT delete superseded ids when the upload failed', async () => {
    writeOutbox(dir, {
      ts: new Date().toISOString(),
      namespace: 'ctx-a-111111',
      entries: [item('c1')],
      supersedes: ['old-1'],
    });
    const calls: string[] = [];
    const request = vi.fn(async (req: { method: string; path: string }) => {
      calls.push(`${req.method} ${req.path}`);
      throw new Error('offline');
    });

    await flushOutbox(restOf(request), dir, { auditLogPath: auditPath });
    expect(calls).toEqual(['POST /v1/memories/batch']);
  });

  it('writes an outbound audit line — a flush is a real upload', async () => {
    writeOutbox(dir, {
      ts: new Date().toISOString(),
      namespace: 'ctx-a-111111',
      entries: [item('c1')],
    });
    await flushOutbox(restOf(vi.fn(async () => okAck)), dir, { auditLogPath: auditPath });

    const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0] as string) as {
      namespace: string;
      count: number;
      digests: string[];
    };
    expect(rec.namespace).toBe('ctx-a-111111');
    expect(rec.count).toBe(1);
    expect(rec.digests[0]).toContain('[files:1]');
  });

  it('retires an empty record rather than letting it jam the queue forever', async () => {
    writeOutbox(dir, { ts: new Date().toISOString(), namespace: 'ctx-a-111111', entries: [] });
    const request = vi.fn(async () => okAck);

    const out = await flushOutbox(restOf(request), dir, { auditLogPath: auditPath });
    expect(request).not.toHaveBeenCalled();
    expect(out.flushed).toBe(1);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('is a no-op (and does not throw) when there is no outbox directory', async () => {
    const request = vi.fn(async () => okAck);
    const out = await flushOutbox(restOf(request), '/definitely/not/a/real/dir');
    expect(out).toEqual({ flushed: 0, entries: 0, remaining: 0 });
    expect(request).not.toHaveBeenCalled();
  });
});
