import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listOutbox, writeOutbox } from '../../src/context/outbox.js';
import { contextLoadTool } from '../../src/tools/context-load.js';

const memory = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  content: '选了 BullMQ 而不是 Redis Streams',
  type: 'decision',
  namespace: 'ctx-x-abc123',
  tags: ['kireo-ctx', 'k-decision', 'h-claude-code', 's-abcd1234'],
  importance: 0.8,
  occurred_at: new Date().toISOString(),
  metadata: { bucket: 'decision', evidence: 'queue.ts', host: 'claude-code', uncertain: false },
  ...over,
});

// `request` is typed `unknown` (not `ReturnType<typeof vi.fn>`): each call site
// below infers its own concrete Mock<Args, Return>, and vitest's Mock type
// checks `mockImplementation` non-bivariantly, so a specific Mock does not
// structurally widen to `Mock<any[], unknown>`. `unknown` sidesteps that
// entirely — matches the `ctxWith(request: unknown)` convention already used
// in tool-memory-recall.test.ts and tool-context-save.test.ts.
const makeCtx = (request: unknown) => ({
  rest: { request } as never,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
});

// `token_budget` has a zod `.default()`, so the handler's inferred input type
// requires it even though callers may omit it — same pattern already used in
// tool-context-save.test.ts for `uncertain_indexes`.
type LoadInput = Parameters<typeof contextLoadTool.handler>[0];

/**
 * The REAL GET /v1/memories envelope: `{ items, next_cursor }` — see
 * apps/api/src/memory/service.ts#ListResult, returned verbatim by
 * routes/memories.ts and asserted in apps/api's own integration test.
 *
 * Every case in this file used to mock `{ data: [...] }`, i.e. it asserted the
 * client's bug against itself. Against the real API `res.data.filter(...)`
 * threw a bare TypeError and /kireo:resume failed outright — 525 green tests
 * and not one of them touching the actual contract.
 */
const listOk = (items: unknown[], nextCursor: string | null = null) => ({
  items,
  next_cursor: nextCursor,
});

describe('context_load tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists the ctx namespace and renders grouped context', async () => {
    const request = vi.fn(async (_opts: { method: string; path: string }) => listOk([memory()]));
    const res = await contextLoadTool.handler({} as LoadInput, makeCtx(request));
    const path = request.mock.calls[0]?.[0]?.path as string;
    expect(path).toContain('/v1/memories');
    expect(path).toContain('namespace=ctx-');
    const text = res.content.map((c) => (c as { text: string }).text).join('');
    expect(text).toContain('Decisions');
    expect(text).toContain('BullMQ');
  });

  it('requests at most LIST_LIMIT_MAX', async () => {
    const request = vi.fn(async (_opts: { method: string; path: string }) => listOk([]));
    await contextLoadTool.handler({} as LoadInput, makeCtx(request));
    const path = request.mock.calls[0]?.[0]?.path as string;
    const limit = Number(new URL(`https://x${path}`).searchParams.get('limit'));
    expect(limit).toBeLessThanOrEqual(200);
  });

  it('falls back to the bucket tag when metadata is absent', async () => {
    const request = vi.fn(async () => listOk([memory({ metadata: undefined })]));
    const res = await contextLoadTool.handler({} as LoadInput, makeCtx(request));
    const text = res.content.map((c) => (c as { text: string }).text).join('');
    expect(text).toContain('Decisions');
  });

  it('returns a usable message rather than erroring for an empty project', async () => {
    const request = vi.fn(async () => listOk([]));
    const res = await contextLoadTool.handler({} as LoadInput, makeCtx(request));
    const text = res.content.map((c) => (c as { text: string }).text).join('');
    expect(text).toMatch(/No structured context has been saved/i);
  });

  it('surfaces a pending outbox so the user knows something is unsent', async () => {
    const request = vi.fn(async () => listOk([]));
    const res = await contextLoadTool.handler(
      { outbox_dir: '/definitely/not/a/real/dir' } as LoadInput,
      makeCtx(request),
    );
    // No throw for a missing dir.
    expect(res.content.length).toBeGreaterThan(0);
  });

  it('rejects the wrong envelope loudly instead of rendering an empty project', async () => {
    // Guards the drift itself: if a future refactor puts the array back under
    // `data`, this must fail rather than quietly look like "nothing saved yet".
    const request = vi.fn(async () => ({ data: [memory()], next_cursor: null }));
    await expect(contextLoadTool.handler({} as LoadInput, makeCtx(request))).rejects.toThrow();
  });

  it('pages past the first 200 rows so old constraints stay visible', async () => {
    // Rows come back occurred_at DESC, so a project with more than one page of
    // saved context used to lose its OLDEST entries permanently — including
    // `constraint` and `open`, the two buckets context-schema.ts gives a null
    // half-life precisely because they do not stop being true with age.
    const old = memory({
      id: 'old-constraint',
      content: '生产是单机换镜像，不能改表 schema',
      tags: ['kireo-ctx', 'k-constraint'],
      metadata: { bucket: 'constraint', host: 'claude-code' },
      occurred_at: new Date(Date.now() - 90 * 86_400_000).toISOString(),
    });
    // Cursor-driven, not call-count-driven: readIndexHead lists the same
    // namespace afterwards, so counting raw calls would be brittle.
    const request = vi.fn(async (opts: { method: string; path: string }) =>
      opts.path.includes('cursor=') ? listOk([old]) : listOk([memory()], 'cursor-1'),
    );

    const res = await contextLoadTool.handler(
      { token_budget: 4000 } as LoadInput,
      makeCtx(request),
    );
    const text = res.content.map((c) => (c as { text: string }).text).join('');
    expect(text).toContain('Constraints');
    expect(text).toContain('不能改表 schema');
    // The follow-up request must carry the cursor the first one handed back.
    const cursored = request.mock.calls.filter((c) => c[0].path.includes('cursor=cursor-1'));
    expect(cursored.length).toBeGreaterThanOrEqual(1);
  });

  it('says so when it stopped paging, instead of implying it saw everything', async () => {
    // Never-ending cursor: the reader must stop AND admit it.
    const request = vi.fn(async () => listOk([memory()], 'more'));
    const res = await contextLoadTool.handler({} as LoadInput, makeCtx(request));
    const text = res.content.map((c) => (c as { text: string }).text).join('');
    expect(text).toContain('More entries have not been fetched');
  });
});

describe('context_load kill switch (spec §10: hit = return immediately, do nothing)', () => {
  // `/kireo:resume` became an OUTBOUND path the day `flushOutbox` was hoisted
  // to the top of context_load (the fix for "the outbox is write-only"), and
  // that hoist shipped with no kill-switch check at all — the only three
  // `isDisabled` call sites in the whole package were cli.ts's backfill,
  // context-save.ts and doctor.ts. So a user who dropped `.kireo/disabled`
  // into a confidential repo, believing nothing could leave it, uploaded every
  // queued context card the next time anything ran a resume. These cases pin
  // the three things that must NOT happen.
  let repo = '';
  let outbox = '';

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'kireo-load-killswitch-'));
    mkdirSync(join(repo, '.kireo'), { recursive: true });
    outbox = join(repo, 'outbox');
    // Exactly the situation the regression exploited: something is queued, and
    // a resume is what flushes it.
    writeOutbox(outbox, {
      ts: new Date().toISOString(),
      namespace: 'ctx-x-abc123',
      entries: [{ content: '客户 A 的合同金额是 320 万', metadata: {} }],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(repo, { recursive: true, force: true });
  });

  const contextMd = () => join(repo, '.kireo', 'CONTEXT.md');

  it('makes NO request, flushes NOTHING, and writes NO CONTEXT.md for a .kireo/disabled repo', async () => {
    writeFileSync(join(repo, '.kireo', 'disabled'), '');
    const request = vi.fn(async () => listOk([]));

    const res = await contextLoadTool.handler(
      { cwd: repo, outbox_dir: outbox } as LoadInput,
      makeCtx(request),
    );

    // 1. Nothing left the device — not the flush, not the list, not the anchor.
    expect(request).not.toHaveBeenCalled();
    // 2. The queued card is still queued (a flush would have dropped the file).
    expect(listOutbox(outbox)).toHaveLength(1);
    // 3. "Do nothing" includes not writing to the repo.
    expect(existsSync(contextMd())).toBe(false);
    expect(res.content.map((c) => (c as { text: string }).text).join('')).toContain(
      'Kireo is disabled',
    );
  });

  it('fires on KIREO_DISABLED alone, with no marker file anywhere', async () => {
    vi.stubEnv('KIREO_DISABLED', '1');
    const request = vi.fn(async () => listOk([]));

    await contextLoadTool.handler({ cwd: repo, outbox_dir: outbox } as LoadInput, makeCtx(request));

    expect(request).not.toHaveBeenCalled();
    expect(listOutbox(outbox)).toHaveLength(1);
    expect(existsSync(contextMd())).toBe(false);
  });

  it('control: without the switch the same call DOES request and DOES write CONTEXT.md', async () => {
    // Without this, all three assertions above would still pass if the handler
    // silently stopped working for an unrelated reason.
    const request = vi.fn(async () => listOk([]));

    await contextLoadTool.handler({ cwd: repo, outbox_dir: outbox } as LoadInput, makeCtx(request));

    expect(request).toHaveBeenCalled();
    expect(existsSync(contextMd())).toBe(true);
  });
});
