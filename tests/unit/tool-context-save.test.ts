import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ContextEntry } from '@kireo/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listOutbox } from '../../src/context/outbox.js';
import { contextSaveTool } from '../../src/tools/context-save.js';

const entry = (over: Partial<ContextEntry> = {}): ContextEntry => ({
  bucket: 'decision',
  content: '选了 BullMQ 而不是 Redis Streams，因为需要延迟队列与重试语义，'.repeat(2),
  evidence: 'apps/api/src/embedding/queue.ts',
  files: ['apps/api/src/embedding/queue.ts'],
  importance: 0.8,
  supersedes: [],
  ...over,
});

// Typed `unknown` (not `ReturnType<typeof vi.fn>`): each call site below infers
// its own concrete Mock<Args, Return>, and vitest's Mock type checks
// `mockImplementation` non-bivariantly, so a specific Mock does not structurally
// widen to `Mock<any[], unknown>`. `unknown` sidesteps that entirely — matches
// the `ctxWith(request: unknown)` convention already used in
// tool-memory-recall.test.ts.
const makeCtx = (request: unknown) => ({
  rest: { request } as never,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
});

describe('context_save tool', () => {
  let outbox: string;
  beforeEach(() => {
    // The first-run acknowledgement marker lives NEXT TO the outbox dir (in
    // its parent), so each test gets a private parent: marker state is then
    // fully controlled through outbox_dir alone. These behavior tests all
    // exercise the normal (post-first-run) path, so the marker is pre-seeded
    // here; the `first run` describe block below deliberately does NOT seed
    // it to pin the forced-preview semantics.
    const base = mkdtempSync(join(tmpdir(), 'kireo-save-'));
    outbox = join(base, 'outbox');
    writeFileSync(join(base, '.first-run-acknowledged'), 'test-preseed\n');
    vi.clearAllMocks();
  });

  it('posts a batch and reports how many were stored', async () => {
    const request = vi.fn(async () => ({ succeeded: [{ index: 0, id: 'm1' }], failures: [] }));
    const res = await contextSaveTool.handler(
      {
        entries: [entry()],
        outbox_dir: outbox,
        host: 'claude-code',
        session_id: 'abc12345',
      } as Parameters<typeof contextSaveTool.handler>[0],
      makeCtx(request),
    );
    expect(request).toHaveBeenCalled();
    const text = res.content.map((c) => (c as { text: string }).text).join('');
    expect(text).toMatch(/1/);
  });

  it('maps buckets onto the existing MemoryType enum, never onto code', async () => {
    const request = vi.fn(async (_opts: { method: string; path: string; body?: unknown }) => ({
      succeeded: [{ index: 0, id: 'm1' }],
      failures: [],
    }));
    await contextSaveTool.handler(
      {
        entries: [entry({ bucket: 'gotcha' })],
        outbox_dir: outbox,
        host: 'codex',
        session_id: 's1',
      } as Parameters<typeof contextSaveTool.handler>[0],
      makeCtx(request),
    );
    const body = request.mock.calls[0]?.[0]?.body as { items: { type: string; tags: string[] }[] };
    expect(body.items[0]?.type).toBe('insight');
    expect(body.items[0]?.type).not.toBe('code');
    expect(body.items[0]?.tags).toContain('kireo-ctx');
  });

  it('writes the outbox BEFORE uploading and clears it on success', async () => {
    const request = vi.fn(async () => ({ succeeded: [{ index: 0, id: 'm1' }], failures: [] }));
    await contextSaveTool.handler(
      {
        entries: [entry()],
        outbox_dir: outbox,
        host: 'claude-code',
        session_id: 's1',
      } as Parameters<typeof contextSaveTool.handler>[0],
      makeCtx(request),
    );
    expect(listOutbox(outbox)).toHaveLength(0);
  });

  it('KEEPS the outbox record when the upload fails, and still reports success to the user', async () => {
    const request = vi.fn(async () => {
      throw new Error('402 quota exceeded');
    });
    const res = await contextSaveTool.handler(
      {
        entries: [entry()],
        outbox_dir: outbox,
        host: 'claude-code',
        session_id: 's1',
      } as Parameters<typeof contextSaveTool.handler>[0],
      makeCtx(request),
    );
    expect(listOutbox(outbox)).toHaveLength(1);
    const text = res.content.map((c) => (c as { text: string }).text).join('');
    expect(text).toMatch(/本地|outbox|稍后/);
  });

  it('rejects an entry with empty evidence before any network call', async () => {
    const request = vi.fn();
    await expect(
      contextSaveTool.handler(
        {
          entries: [entry({ evidence: '' })],
          outbox_dir: outbox,
          host: 'x',
          session_id: 's1',
        } as Parameters<typeof contextSaveTool.handler>[0],
        makeCtx(request),
      ),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('truncates oversized metadata instead of throwing', async () => {
    const request = vi.fn(async (_opts: { method: string; path: string; body?: unknown }) => ({
      succeeded: [{ index: 0, id: 'm1' }],
      failures: [],
    }));
    await contextSaveTool.handler(
      {
        entries: [
          entry({ files: Array.from({ length: 10 }, (_, i) => `p/${'x'.repeat(300)}${i}.ts`) }),
        ],
        outbox_dir: outbox,
        host: 'claude-code',
        session_id: 's1',
      } as Parameters<typeof contextSaveTool.handler>[0],
      makeCtx(request),
    );
    const body = request.mock.calls[0]?.[0]?.body as { items: { metadata: unknown }[] };
    expect(Buffer.byteLength(JSON.stringify(body.items[0]?.metadata))).toBeLessThanOrEqual(2048);
  });

  it('redacts credential shapes in files before they reach the wire, and audits files', async () => {
    const request = vi.fn(async (_opts: { method: string; path: string; body?: unknown }) => ({
      succeeded: [{ index: 0, id: 'm1' }],
      failures: [],
    }));
    const auditPath = join(dirname(outbox), 'outbound.jsonl');
    await contextSaveTool.handler(
      {
        entries: [entry({ files: ['deploy/AKIAIOSFODNN7EXAMPLE.pem'] })],
        outbox_dir: outbox,
        audit_log_path: auditPath,
        host: 'claude-code',
        session_id: 's1',
      } as Parameters<typeof contextSaveTool.handler>[0],
      makeCtx(request),
    );
    const body = request.mock.calls[0]?.[0]?.body as {
      items: { metadata: { files: string[] } }[];
    };
    expect(body.items[0]?.metadata.files[0]).toContain('[REDACTED]');
    expect(JSON.stringify(body)).not.toContain('AKIAIOSFODNN7EXAMPLE');
    // The outbound audit summary must cover files too — a files-only leak
    // otherwise departs the device with zero trace in the audit log.
    const audit = readFileSync(auditPath, 'utf8');
    expect(audit).toMatch(/files:1/);
  });
});

describe('context_save tool — first run (no acknowledgement marker)', () => {
  // Deliberately NO marker pre-seeding here: outbox_dir's parent is a fresh
  // temp dir, so `.first-run-acknowledged` is absent and the forced-preview
  // gate is armed.
  let outbox: string;
  let markerPath: string;
  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'kireo-first-run-'));
    outbox = join(base, 'outbox');
    markerPath = join(base, '.first-run-acknowledged');
    vi.clearAllMocks();
  });

  it('forces a preview when dry_run is omitted: no request, no outbox, full preview text returned', async () => {
    const request = vi.fn(async () => ({ succeeded: [{ index: 0, id: 'm1' }], failures: [] }));
    const res = await contextSaveTool.handler(
      {
        entries: [entry()],
        outbox_dir: outbox,
        host: 'claude-code',
        session_id: 's1',
      } as Parameters<typeof contextSaveTool.handler>[0],
      makeCtx(request),
    );
    expect(request).not.toHaveBeenCalled();
    expect(listOutbox(outbox)).toHaveLength(0);
    // The forced preview itself must NOT count as acknowledgement.
    expect(existsSync(markerPath)).toBe(false);
    const text = res.content.map((c) => (c as { text: string }).text).join('');
    // The exact content that would be uploaded is shown to the user...
    expect(text).toContain('BullMQ');
    // ...and the caller is told this is a first-run forced preview and how
    // to proceed (explicit dry_run:false).
    expect(text).toMatch(/First-run preview/);
    expect(text).toMatch(/dry_run/);
  });

  it('forces a preview even when the caller passes dry_run:true (no side effects either)', async () => {
    const request = vi.fn(async () => ({ succeeded: [{ index: 0, id: 'm1' }], failures: [] }));
    await contextSaveTool.handler(
      {
        entries: [entry()],
        outbox_dir: outbox,
        host: 'claude-code',
        session_id: 's1',
        dry_run: true,
      } as Parameters<typeof contextSaveTool.handler>[0],
      makeCtx(request),
    );
    expect(request).not.toHaveBeenCalled();
    expect(listOutbox(outbox)).toHaveLength(0);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('an explicit dry_run:false performs the real save AND creates the marker', async () => {
    const request = vi.fn(async () => ({ succeeded: [{ index: 0, id: 'm1' }], failures: [] }));
    const res = await contextSaveTool.handler(
      {
        entries: [entry()],
        outbox_dir: outbox,
        host: 'claude-code',
        session_id: 's1',
        dry_run: false,
      } as Parameters<typeof contextSaveTool.handler>[0],
      makeCtx(request),
    );
    expect(request).toHaveBeenCalled();
    expect(existsSync(markerPath)).toBe(true);
    // Upload succeeded → outbox cleared, normal success summary.
    expect(listOutbox(outbox)).toHaveLength(0);
    const text = res.content.map((c) => (c as { text: string }).text).join('');
    expect(text).toMatch(/Saved/);
  });

  it('after the marker exists, an omitted dry_run goes back to being a real save', async () => {
    const request = vi.fn(async () => ({ succeeded: [{ index: 0, id: 'm1' }], failures: [] }));
    // First: acknowledge via explicit dry_run:false.
    await contextSaveTool.handler(
      {
        entries: [entry()],
        outbox_dir: outbox,
        host: 'claude-code',
        session_id: 's1',
        dry_run: false,
      } as Parameters<typeof contextSaveTool.handler>[0],
      makeCtx(request),
    );
    expect(existsSync(markerPath)).toBe(true);
    // Then: the pre-marker default (omitted dry_run) performs a real save.
    await contextSaveTool.handler(
      {
        entries: [entry()],
        outbox_dir: outbox,
        host: 'claude-code',
        session_id: 's2',
      } as Parameters<typeof contextSaveTool.handler>[0],
      makeCtx(request),
    );
    // Each real save now also upserts the kireo-home card (Task 4): a batch
    // POST, plus the home card's own GET (look for an old card) and POST
    // (write the new one) — no DELETE, since this mock never returns one.
    // 3 calls per save x 2 saves = 6.
    expect(request).toHaveBeenCalledTimes(6);
  });
});

describe('context_save tool — REAL dispatch path (safeParse → handler, exactly as server.ts)', () => {
  // Round-1 regression pinning. server.ts does NOT hand handlers the raw
  // request arguments — it runs `tool.zod.safeParse(req.params.arguments)`
  // first and passes `parsed.data` (server.ts:50/58). Every other test in
  // this file calls the handler with a literal object, which bypasses
  // whatever zod does during parsing — which is exactly how the round-1
  // "check `'dry_run' in rawInput`" fix passed all unit tests while being
  // dead code in production: `.default(false)` backfilled an omitted dry_run
  // into a literal `false` during safeParse, so the key was always present
  // and always false, the forced-preview branch never ran, and a first-run
  // save left the device without any preview. These tests therefore MUST go
  // through safeParse before touching the handler.
  let outbox: string;
  let markerPath: string;
  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'kireo-dispatch-'));
    outbox = join(base, 'outbox');
    markerPath = join(base, '.first-run-acknowledged');
    vi.clearAllMocks();
  });

  // Mirrors server.ts:50-58 — safeParse, then hand parsed.data (never the raw
  // object) to the handler.
  const parseAsServerDoes = (args: Record<string, unknown>) => {
    const parsed = contextSaveTool.zod.safeParse(args);
    if (!parsed.success) throw new Error(`safeParse failed: ${parsed.error.message}`);
    return parsed.data as Parameters<typeof contextSaveTool.handler>[0];
  };

  it('first run + omitted dry_run: parsed data still forces a preview (no request, no outbox, no marker)', async () => {
    const request = vi.fn(async () => ({ succeeded: [{ index: 0, id: 'm1' }], failures: [] }));
    const data = parseAsServerDoes({
      entries: [entry()],
      host: 'claude-code',
      session_id: 's1',
      outbox_dir: outbox,
    });
    // The property the whole gate rests on: parsing must NOT backfill an
    // omitted dry_run. If this assertion fails, someone re-added a schema
    // default and re-opened the round-1 hole.
    expect((data as { dry_run?: unknown }).dry_run).toBeUndefined();

    const res = await contextSaveTool.handler(data, makeCtx(request));
    // First run + omitted dry_run → MUST be a preview: nothing leaves the
    // device, nothing is written, and the gate stays armed.
    expect(request).not.toHaveBeenCalled();
    expect(listOutbox(outbox)).toHaveLength(0);
    expect(existsSync(markerPath)).toBe(false);
    const text = res.content.map((c) => (c as { text: string }).text).join('');
    expect(text).toContain('BullMQ');
    expect(text).toMatch(/First-run preview/);
    expect(text).toMatch(/dry_run/);
  });

  it('first run + explicit dry_run:false through the same parse path: real save, marker created', async () => {
    const request = vi.fn(async () => ({ succeeded: [{ index: 0, id: 'm1' }], failures: [] }));
    const data = parseAsServerDoes({
      entries: [entry()],
      host: 'claude-code',
      session_id: 's1',
      outbox_dir: outbox,
      dry_run: false,
    });
    expect((data as { dry_run?: unknown }).dry_run).toBe(false);

    const res = await contextSaveTool.handler(data, makeCtx(request));
    expect(request).toHaveBeenCalled();
    expect(existsSync(markerPath)).toBe(true);
    // Upload succeeded → outbox cleared, normal success summary.
    expect(listOutbox(outbox)).toHaveLength(0);
    const text = res.content.map((c) => (c as { text: string }).text).join('');
    expect(text).toMatch(/Saved/);
  });

  it('marker present + omitted dry_run through the parse path: ordinary real save', async () => {
    const request = vi.fn(async () => ({ succeeded: [{ index: 0, id: 'm1' }], failures: [] }));
    writeFileSync(markerPath, 'test-preseed\n');
    const data = parseAsServerDoes({
      entries: [entry()],
      host: 'claude-code',
      session_id: 's1',
      outbox_dir: outbox,
    });
    await contextSaveTool.handler(data, makeCtx(request));
    // Batch POST + the home card's GET (no old card) + POST (Task 4) = 3.
    expect(request).toHaveBeenCalledTimes(3);
    expect(listOutbox(outbox)).toHaveLength(0);
  });
});

describe('context_save supersedes ordering (review finding: net context loss)', () => {
  let outbox: string;
  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'kireo-save-sup-'));
    outbox = join(base, 'outbox');
    writeFileSync(join(base, '.first-run-acknowledged'), 'test-preseed\n');
    vi.clearAllMocks();
  });

  const save = (request: unknown, over: Record<string, unknown> = {}) =>
    contextSaveTool.handler(
      {
        entries: [entry({ bucket: 'constraint', supersedes: ['old-1', 'old-2'] })],
        outbox_dir: outbox,
        host: 'claude-code',
        session_id: 's1',
        ...over,
      } as Parameters<typeof contextSaveTool.handler>[0],
      makeCtx(request),
    );

  it('deletes the superseded entries when the upload SUCCEEDED', async () => {
    const calls: string[] = [];
    const request = vi.fn(async (req: { method: string; path: string }) => {
      calls.push(`${req.method} ${req.path}`);
      return { succeeded: [{ index: 0, id: 'm1' }], failures: [] };
    });
    await save(request);
    expect(calls).toContain('DELETE /v1/memories/old-1');
    expect(calls).toContain('DELETE /v1/memories/old-2');
  });

  it('does NOT delete them when the batch upload failed', async () => {
    // The concrete loss: free tier's 200 monthly writes run out, POST
    // /v1/memories/batch 402s (it carries requireQuota), the catch swallows it
    // and sets `pending` — and the loop then DELETEd both old entries anyway,
    // because DELETE /memories/:id deliberately has no write-quota guard
    // ("删除减少用量，绝不能挂写配额"). Old context gone, new context never
    // stored, summary silent about both. Every device's resume then returned
    // strictly less than before the save.
    const calls: string[] = [];
    const request = vi.fn(async (req: { method: string; path: string }) => {
      calls.push(`${req.method} ${req.path}`);
      if (req.path === '/v1/memories/batch') throw new Error('QUOTA_EXCEEDED');
      return {};
    });
    const res = await save(request);

    expect(calls.filter((c) => c.startsWith('DELETE /v1/memories/old-'))).toEqual([]);
    const text = res.content.map((c) => (c as { text: string }).text).join('');
    expect(text).toContain('will be removed after this batch uploads');
  });

  it('carries the supersede intent into the outbox so a flush can finish the job', async () => {
    // Without this the delete intent is unrecoverable: a replayed record would
    // re-upload the replacement and resurrect the duplicate it overturned.
    const request = vi.fn(async (req: { path: string }) => {
      if (req.path === '/v1/memories/batch') throw new Error('offline');
      return {};
    });
    await save(request);
    const [rec] = listOutbox(outbox);
    expect(rec?.rec.supersedes).toEqual(['old-1', 'old-2']);
  });
});

describe('context_save evidence verification (spec §6.2[4], previously unwired)', () => {
  let outbox: string;
  let transcript: string;
  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'kireo-save-verify-'));
    outbox = join(base, 'outbox');
    transcript = join(base, 'session.jsonl');
    writeFileSync(join(base, '.first-run-acknowledged'), 'test-preseed\n');
    vi.clearAllMocks();
  });

  const withTranscript = (text: string) => {
    writeFileSync(transcript, text);
    return transcript;
  };

  const claudeLine = (text: string) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

  interface SavedItem {
    metadata: { uncertain: boolean };
  }

  const runSave = async (
    entries: ContextEntry[],
    over: Record<string, unknown> = {},
  ): Promise<SavedItem[]> => {
    const sent: SavedItem[][] = [];
    const request = vi.fn(async (req: { body?: unknown }) => {
      sent.push(((req.body as { items?: SavedItem[] })?.items ?? []) as SavedItem[]);
      return { succeeded: entries.map((_, i) => ({ index: i, id: `m${i}` })), failures: [] };
    });
    await contextSaveTool.handler(
      {
        entries,
        outbox_dir: outbox,
        host: 'claude-code',
        session_id: 's1',
        ...over,
      } as Parameters<typeof contextSaveTool.handler>[0],
      makeCtx(request),
    );
    return sent[0] ?? [];
  };

  it('marks an entry uncertain when its cited file never appears in the session', async () => {
    // verifyEvidence had a full unit-test suite and ZERO production callers,
    // and neither host prompt mentioned uncertain_indexes — so `uncertain` was
    // permanently empty and render.ts's `[uncertain]` marker unreachable, while
    // both resume prompts tell the model "no marker = the evidence was
    // checked". Every fabricated card shipped as confirmed fact.
    const items = await runSave(
      [
        entry({
          evidence: 'apps/api/src/embedding/queue.ts',
          files: ['apps/api/src/embedding/queue.ts'],
        }),
        entry({ evidence: 'src/totally/made/up.ts', files: ['src/totally/made/up.ts'] }),
      ],
      {
        transcript_path: withTranscript(
          `${claudeLine('看一下 apps/api/src/embedding/queue.ts')}\n`,
        ),
      },
    );
    expect(items[0]?.metadata.uncertain).toBe(false);
    expect(items[1]?.metadata.uncertain).toBe(true);
  });

  it('unions the model self-assessment with the transcript check', async () => {
    const items = await runSave(
      [entry({ evidence: 'apps/api/src/embedding/queue.ts', files: [] })],
      {
        transcript_path: withTranscript(
          `${claudeLine('看一下 apps/api/src/embedding/queue.ts')}\n`,
        ),
        uncertain_indexes: [0],
      },
    );
    expect(items[0]?.metadata.uncertain).toBe(true);
  });

  it('degrades OPEN when there is no readable transcript — never blocks the save', async () => {
    const items = await runSave(
      [entry({ evidence: 'src/made/up.ts', files: ['src/made/up.ts'] })],
      {
        transcript_path: '/definitely/not/a/file.jsonl',
      },
    );
    expect(items[0]?.metadata.uncertain).toBe(false);
  });

  it('degrades OPEN on an unreadable transcript FORMAT too', async () => {
    const items = await runSave(
      [entry({ evidence: 'src/made/up.ts', files: ['src/made/up.ts'] })],
      {
        transcript_path: withTranscript('this is not jsonl at all\n'),
      },
    );
    expect(items[0]?.metadata.uncertain).toBe(false);
  });
});
