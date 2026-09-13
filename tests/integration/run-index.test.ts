import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { RestClient } from '../../src/rest/client.js';
import { runIndex } from '../../src/index/run-index.js';
import { MEMORY_LIMITS } from '@kireo/shared';

function repoFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'kireo-index-'));
  writeFileSync(join(root, 'math.ts'), 'export function add(a: number, b: number) { return a + b; }');
  return root;
}

const logger = pino({ level: 'silent' });

describe('runIndex', () => {
  it('batches code symbols with type=code and derived namespace', async () => {
    const root = repoFixture();
    const calls: { method: string; path: string; body?: unknown; query?: unknown }[] = [];
    const request = vi.fn(async (o: { method: string; path: string; body?: unknown; query?: unknown }) => {
      calls.push(o);
      return { succeeded: [{ index: 0, id: 'mem_1' }], failures: [] };
    });
    const rest = { request } as unknown as RestClient;

    const summary = await runIndex({ rest, logger, root, repo: 'demo' });

    expect(summary.namespace).toBe('code-demo');
    expect(summary.symbols).toBe(1);
    const batch = calls.find((c) => c.path === '/v1/memories/batch');
    expect(batch).toBeTruthy();
    type ItemShape = { type: string; namespace: string; metadata: { symbol_name: string; file_path: string } };
    const items = ((batch!.body as unknown as { items: unknown[] }).items) as ItemShape[];
    expect(items[0]!.type).toBe('code');
    expect(items[0]!.namespace).toBe('code-demo');
    expect(items[0]!.metadata.symbol_name).toBe('add');
    expect(items[0]!.metadata.file_path).toBe('math.ts');
  });

  it('skips unchanged files on re-run and deletes removed files', async () => {
    const root = repoFixture();
    const request = vi.fn(async (o: { path: string }) => {
      if (o.path === '/v1/memories/batch') return { succeeded: [{ index: 0, id: 'mem_1' }], failures: [] };
      return {};
    });
    const rest = { request } as unknown as RestClient;

    // First run indexes math.ts.
    await runIndex({ rest, logger, root, repo: 'demo' });
    const afterFirst = request.mock.calls.length;

    // Second run: nothing changed -> no new batch.
    const second = await runIndex({ rest, logger, root, repo: 'demo' });
    expect(second.filesChanged).toBe(0);
    expect(request.mock.calls.length).toBe(afterFirst);

    // Delete the file -> third run issues a DELETE for it.
    rmSync(join(root, 'math.ts'));
    const third = await runIndex({ rest, logger, root, repo: 'demo' });
    expect(third.filesDeleted).toBe(1);
    const del = request.mock.calls.find(
      (c) => (c[0] as unknown as { method: string }).method === 'DELETE',
    );
    expect(del).toBeTruthy();
    // `file_paths` (plural, comma-joined) — the batched delete contract this
    // branch moved to (run-index.ts joins them, routes/memories.ts caps the
    // list at DELETE_FILE_PATHS_MAX). This assertion still pinned the
    // pre-change singular `file_path`, so it asserted a contract that no
    // longer exists on either side.
    const delArg = del![0] as unknown as { query: { file_paths: string; namespace: string } };
    expect(delArg.query.file_paths.split(',')).toEqual(['math.ts']);
    expect(delArg.query.namespace).toBe('code-demo');
  });

  it('subtracts batch failures from summary.symbols', async () => {
    const root = repoFixture();
    const request = vi.fn(async (o: { path: string }) => {
      if (o.path === '/v1/memories/batch') {
        // Report 1 failure out of 1 item → net 0 succeeded
        return { succeeded: [], failures: [{ index: 0, code: 'validation_error', message: 'bad content' }] };
      }
      return {};
    });
    const rest = { request } as unknown as RestClient;

    const summary = await runIndex({ rest, logger, root, repo: 'demo' });
    // The file has 1 symbol, but the batch reports 1 failure → 0 succeeded
    expect(summary.symbols).toBe(0);
  });

  it('chunks into multiple batches when symbol count exceeds BATCH_MAX', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kireo-index-big-'));
    // Generate BATCH_MAX+1 exported TS functions in one file
    const count = MEMORY_LIMITS.BATCH_MAX + 1;
    const lines = Array.from({ length: count }, (_, i) => `export function fn${i}() { return ${i}; }`);
    writeFileSync(join(root, 'big.ts'), lines.join('\n'));

    const request = vi.fn(async (o: { path: string }) => {
      if (o.path === '/v1/memories/batch') return { succeeded: [], failures: [] };
      return {};
    });
    const rest = { request } as unknown as RestClient;

    const summary = await runIndex({ rest, logger, root, repo: 'bigdemo' });
    expect(summary.batches).toBeGreaterThan(1);
    // Two batch calls should have been made
    const batchCalls = (request.mock.calls as unknown[]).filter(
      (c) => ((c as unknown[])[0] as { path: string }).path === '/v1/memories/batch',
    );
    expect(batchCalls.length).toBeGreaterThan(1);
  });
});
