import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { RestClient } from '../../src/rest/client.js';
import type { BatchCreateResponse } from '../../src/rest/types.js';
import { runIndex } from '../../src/index/run-index.js';

/** Temp repo with three top-level Python functions -> three code symbols. */
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'kireo-run-index-'));
  writeFileSync(
    join(root, 'mod.py'),
    'def a():\n    return 1\n\n\ndef b():\n    return 2\n\n\ndef c():\n    return 3\n',
  );
  return root;
}

function fakeLogger(): Logger & { errors: unknown[][]; warns: unknown[][] } {
  const errors: unknown[][] = [];
  const warns: unknown[][] = [];
  const logger = {
    errors,
    warns,
    error: (...a: unknown[]) => errors.push(a),
    warn: (...a: unknown[]) => warns.push(a),
    info: () => undefined,
    debug: () => undefined,
  };
  return logger as unknown as Logger & { errors: unknown[][]; warns: unknown[][] };
}

function okResponse(items: unknown[]): BatchCreateResponse {
  const list = items as { length: number }[];
  return {
    succeeded: Array.from({ length: list.length }, (_, i) => ({ index: i, id: `id-${i}` })),
    failures: [],
  };
}

describe('runIndex batchSize (BUG-001)', () => {
  it('honours a custom batchSize when chunking symbols', async () => {
    const root = makeFixture();
    const batchBodies: number[] = [];
    const rest = {
      request: vi.fn(async (req: { body?: { items?: unknown[] } }) => {
        batchBodies.push(req.body?.items?.length ?? 0);
        return okResponse(req.body?.items ?? []);
      }),
    } as unknown as RestClient;

    const summary = await runIndex({
      rest,
      logger: fakeLogger(),
      root,
      repo: 'demo',
      batchSize: 2,
    });

    // 3 symbols with batchSize 2 -> two batches of sizes [2, 1].
    expect(summary.batches).toBe(2);
    expect(batchBodies).toEqual([2, 1]);
    expect(summary.symbols).toBe(3);
  });

  it('clamps an oversized batchSize down to BATCH_MAX (single batch)', async () => {
    const root = makeFixture();
    const rest = {
      request: vi.fn(async (req: { body?: { items?: unknown[] } }) =>
        okResponse(req.body?.items ?? []),
      ),
    } as unknown as RestClient;

    const summary = await runIndex({
      rest,
      logger: fakeLogger(),
      root,
      repo: 'demo',
      batchSize: 10_000,
    });
    expect(summary.batches).toBe(1);
  });
});

describe('runIndex failure logging (BUG-002 client)', () => {
  it('reports confirmed/attempted batches and a safe-to-retry message on abort', async () => {
    const root = makeFixture();
    let call = 0;
    const rest = {
      request: vi.fn(async (req: { body?: { items?: unknown[] } }) => {
        call += 1;
        if (call === 2) throw new Error('request timeout after 60000ms');
        return okResponse(req.body?.items ?? []);
      }),
    } as unknown as RestClient;
    const logger = fakeLogger();

    await expect(runIndex({ rest, logger, root, repo: 'demo', batchSize: 2 })).rejects.toThrow(
      /timeout/,
    );

    expect(logger.errors).toHaveLength(1);
    const [meta, msg] = logger.errors[0] as [Record<string, number>, string];
    // First batch acked, second batch was in-flight when it aborted.
    expect(meta.batchesConfirmed).toBe(1);
    expect(meta.batchesAttempted).toBe(2);
    expect(meta.batchesTotal).toBe(2);
    // Message must NOT claim "sent: 0" and must say re-running is safe (dedupe).
    expect(msg).not.toContain('sent');
    expect(msg).toMatch(/may already be committed/i);
    expect(msg).toMatch(/dedupe|dedupes/i);
  });
});
