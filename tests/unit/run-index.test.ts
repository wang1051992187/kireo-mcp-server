import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { resolveProjectHere } from '../../src/context/project.js';
import { INDEX_HEAD_TAG } from '../../src/index/index-head.js';
import { runIndex } from '../../src/index/run-index.js';
import type { RestClient } from '../../src/rest/client.js';
import type { BatchCreateResponse } from '../../src/rest/types.js';

/** Temp repo with three top-level Python functions -> three code symbols. */
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'kireo-run-index-'));
  writeFileSync(
    join(root, 'mod.py'),
    'def a():\n    return 1\n\n\ndef b():\n    return 2\n\n\ndef c():\n    return 3\n',
  );
  return root;
}

type FakeLogger = Logger & { errors: unknown[][]; warns: unknown[][]; infos: unknown[][] };

function fakeLogger(): FakeLogger {
  const errors: unknown[][] = [];
  const warns: unknown[][] = [];
  const infos: unknown[][] = [];
  const logger = {
    errors,
    warns,
    infos,
    error: (...a: unknown[]) => errors.push(a),
    warn: (...a: unknown[]) => warns.push(a),
    info: (...a: unknown[]) => infos.push(a),
    debug: () => undefined,
  };
  return logger as unknown as FakeLogger;
}

/** True if any logger.info() call included a string containing `substr`. */
function loggedInfo(logger: FakeLogger, substr: string): boolean {
  return logger.infos.some((call) => call.some((a) => typeof a === 'string' && a.includes(substr)));
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

/**
 * A rest mock that ACKs POST /v1/memories/batch (no failures) and ACKs
 * DELETE /v1/memories with `{ deleted: 0 }` — enough to drive runIndex through
 * a full prune+upload cycle without a real server.
 */
function makeRestMock(): RestClient & {
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async (req: { method: string; body?: { items?: unknown[] } }) => {
    if (req.method === 'POST') return okResponse(req.body?.items ?? []);
    if (req.method === 'DELETE') return { deleted: 0 };
    return {};
  });
  return { request } as unknown as RestClient & { request: ReturnType<typeof vi.fn> };
}

/**
 * Repo with two TS files. Caller re-indexes it after mutating the filesystem
 * (edit one file, delete the other) so a second `runIndex` call sees both a
 * CHANGED and a DELETED path in the same run.
 */
function makeMixedFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'kireo-run-index-prune-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'changed.ts'), 'export function foo() {\n  return 1;\n}\n');
  writeFileSync(join(root, 'src', 'removed.ts'), 'export function bar() {\n  return 2;\n}\n');
  return root;
}

/** DELETE calls made against a mock's call log, in call order. */
function deleteCalls(rest: { request: ReturnType<typeof vi.fn> }) {
  return rest.request.mock.calls.filter((c) => (c[0] as { method: string }).method === 'DELETE');
}

/** file_paths sent across a set of DELETE calls, flattened (comma-separated per call). */
function deletedFilePaths(calls: unknown[][]): string[] {
  return calls.flatMap((c) => {
    const q = (c[0] as { query?: { file_paths?: string } }).query;
    return (q?.file_paths ?? '').split(',').filter((p) => p.length > 0);
  });
}

describe('runIndex symbol pruning for changed + deleted files (KIREO context-relay §6.4)', () => {
  it('prunes stale symbols for CHANGED files, not only deleted ones', async () => {
    const root = makeMixedFixture();
    // First run establishes prior state for both files.
    await runIndex({ rest: makeRestMock(), logger: fakeLogger(), root, repo: 'demo' });

    // changed.ts's function is renamed (its old symbol row must be pruned);
    // removed.ts is deleted outright.
    writeFileSync(
      join(root, 'src', 'changed.ts'),
      'export function fooRenamed() {\n  return 1;\n}\n',
    );
    rmSync(join(root, 'src', 'removed.ts'));

    const rest = makeRestMock();
    await runIndex({ rest, logger: fakeLogger(), root, repo: 'demo' });

    const paths = deletedFilePaths(deleteCalls(rest));
    expect(paths).toContain('src/changed.ts');
    expect(paths).toContain('src/removed.ts');
  });

  it('sends changed and deleted paths in ONE delete request', async () => {
    const root = makeMixedFixture();
    await runIndex({ rest: makeRestMock(), logger: fakeLogger(), root, repo: 'demo' });

    writeFileSync(
      join(root, 'src', 'changed.ts'),
      'export function fooRenamed() {\n  return 1;\n}\n',
    );
    rmSync(join(root, 'src', 'removed.ts'));

    const rest = makeRestMock();
    await runIndex({ rest, logger: fakeLogger(), root, repo: 'demo' });

    expect(deleteCalls(rest).length).toBe(1);
  });

  it('prunes BEFORE uploading, so a symbol that still exists is re-created', async () => {
    const root = makeMixedFixture();
    await runIndex({ rest: makeRestMock(), logger: fakeLogger(), root, repo: 'demo' });

    writeFileSync(
      join(root, 'src', 'changed.ts'),
      'export function fooRenamed() {\n  return 1;\n}\n',
    );
    rmSync(join(root, 'src', 'removed.ts'));

    const rest = makeRestMock();
    const summary = await runIndex({ rest, logger: fakeLogger(), root, repo: 'demo' });

    const order = rest.request.mock.calls.map((c) => (c[0] as { method: string }).method);
    const deleteIdx = order.indexOf('DELETE');
    const postIdx = order.indexOf('POST');
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(postIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeLessThan(postIdx);
    // The re-created symbol (fooRenamed, from the still-existing changed.ts)
    // must actually be uploaded, not silently dropped by the prune.
    expect(summary.symbols).toBeGreaterThan(0);
  });

  it('reports the number of pruned symbols on the summary', async () => {
    const root = makeMixedFixture();
    await runIndex({ rest: makeRestMock(), logger: fakeLogger(), root, repo: 'demo' });

    writeFileSync(
      join(root, 'src', 'changed.ts'),
      'export function fooRenamed() {\n  return 1;\n}\n',
    );
    rmSync(join(root, 'src', 'removed.ts'));

    const rest = makeRestMock();
    rest.request.mockImplementation(
      async (req: { method: string; body?: { items?: unknown[] } }) => {
        if (req.method === 'POST') return okResponse(req.body?.items ?? []);
        if (req.method === 'DELETE') return { deleted: 2 };
        return {};
      },
    );

    const summary = await runIndex({ rest, logger: fakeLogger(), root, repo: 'demo' });
    expect(summary.symbolsPruned).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Commit-anchor cross-device path.
//
// Every fixture above is a bare mkdtemp dir: `git rev-parse HEAD` fails there,
// `headCommit` stays null, and the anchor branch of runIndex never executes.
// The review flagged exactly that gap — the tests below drive runIndex over a
// REAL git repo plus an in-memory server so the anchor branch (read anchor →
// git diff → selective re-extract → advance anchor) has a regression net.
// ---------------------------------------------------------------------------

/** Run git in `root`, stderr captured (suppresses init/commit chatter). */
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Real git repo with three committed Python files: one that never changes,
 * one that will be edited, one that will be deleted.
 */
function makeGitFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'kireo-run-index-anchor-'));
  writeFileSync(join(root, 'stable.py'), 'def stay():\n    return 1\n');
  writeFileSync(join(root, 'edited.py'), 'def before():\n    return 2\n');
  writeFileSync(join(root, 'removed.py'), 'def gone():\n    return 3\n');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'kireo@test.invalid');
  git(root, 'config', 'user.name', 'kireo');
  git(root, 'add', '--', 'stable.py', 'edited.py', 'removed.py');
  git(root, 'commit', '-q', '-m', 'c0');
  return root;
}

interface AnchorRow {
  id: string;
  namespace: string;
  content: string;
  type: string;
  tags: string[];
  occurred_at: string;
  metadata: Record<string, unknown>;
  deleted: boolean;
}

/**
 * In-memory server shared across runIndex calls: persists anchor cards
 * (create / list / soft-delete-by-id) and ACKs symbol batches and prunes.
 * Persistence across calls is the point — it is what lets one test drive the
 * true cross-device flow, where device A writes the anchor that device B
 * later reads back.
 */
function makeAnchorServer() {
  const rows: AnchorRow[] = [];
  let nextId = 1;
  const batchedFilePaths: string[] = [];
  const prunedFilePaths: string[] = [];
  const request = vi.fn(
    async (req: {
      method: string;
      path: string;
      query?: Record<string, string>;
      body?: Record<string, unknown>;
    }) => {
      const { method, path } = req;
      if (method === 'GET' && path.startsWith('/v1/memories?')) {
        const ns = new URL(`http://x${path}`).searchParams.get('namespace');
        // `items` — the real GET /v1/memories envelope. This fake used to
        // answer `data`, faithfully reproducing the client's own bug.
        return { items: rows.filter((r) => !r.deleted && r.namespace === ns) };
      }
      if (method === 'POST' && path === '/v1/memories/batch') {
        const items = (req.body?.items ?? []) as { metadata?: { file_path?: string } }[];
        for (const item of items) {
          if (item.metadata?.file_path) batchedFilePaths.push(item.metadata.file_path);
        }
        return okResponse(items);
      }
      if (method === 'POST' && path === '/v1/memories') {
        const body = req.body as unknown as Omit<AnchorRow, 'id' | 'deleted'>;
        const row: AnchorRow = { ...body, id: `m-${nextId++}`, deleted: false };
        rows.push(row);
        return { id: row.id };
      }
      if (method === 'DELETE' && path === '/v1/memories') {
        const paths = (req.query?.file_paths ?? '').split(',').filter((p) => p.length > 0);
        prunedFilePaths.push(...paths);
        return { deleted: 0 };
      }
      if (method === 'DELETE' && path.startsWith('/v1/memories/')) {
        const id = decodeURIComponent(path.slice('/v1/memories/'.length));
        const row = rows.find((r) => r.id === id);
        if (row) row.deleted = true;
        return {};
      }
      throw new Error(`unhandled ${method} ${path}`);
    },
  );
  return {
    rows,
    request,
    batchedFilePaths,
    prunedFilePaths,
    rest: { request } as unknown as RestClient,
    seedAnchor(
      namespace: string,
      commit: string,
      occurredAt: string,
      scope: { codeNs: string; indexRoot: string } = { codeNs: 'code-demo', indexRoot: '' },
    ): void {
      rows.push({
        id: `m-${nextId++}`,
        namespace,
        content: `index head @ ${commit}`,
        type: 'fact',
        tags: [INDEX_HEAD_TAG],
        occurred_at: occurredAt,
        // An anchor is scoped to the (code bucket, index root) it describes —
        // an unscoped one is legacy and deliberately never read.
        metadata: { commit, code_ns: scope.codeNs, index_root: scope.indexRoot },
        deleted: false,
      });
    },
    liveAnchors(namespace: string): AnchorRow[] {
      return rows.filter(
        (r) => !r.deleted && r.namespace === namespace && r.tags.includes(INDEX_HEAD_TAG),
      );
    },
  };
}

describe('runIndex commit-anchor cross-device path (review finding: untested anchor branch)', () => {
  it('device B with no local state uses the server anchor + git diff instead of a full scan', async () => {
    const root = makeGitFixture();
    const server = makeAnchorServer();
    const ctxNs = resolveProjectHere(root).ctxNs;

    // Device A: first index — full scan, then writes the anchor at c0.
    await runIndex({ rest: server.rest, logger: fakeLogger(), root, repo: 'demo' });
    const c0 = git(root, 'rev-parse', 'HEAD').trim();
    expect(server.liveAnchors(ctxNs)).toHaveLength(1);
    expect(server.liveAnchors(ctxNs)[0]?.metadata.commit).toBe(c0);

    // The repo moves on: one edit, one delete, one add — committed as c1.
    writeFileSync(join(root, 'edited.py'), 'def after():\n    return 2\n');
    rmSync(join(root, 'removed.py'));
    writeFileSync(join(root, 'added.py'), 'def fresh():\n    return 4\n');
    git(root, 'add', '--', 'added.py');
    git(root, 'commit', '-q', '-a', '-m', 'c1');
    const c1 = git(root, 'rev-parse', 'HEAD').trim();

    // Device B: same server, but a fresh checkout — no .kireo/index-state.json.
    rmSync(join(root, '.kireo'), { recursive: true, force: true });
    server.batchedFilePaths.length = 0;
    server.prunedFilePaths.length = 0;
    const logger = fakeLogger();
    const summary = await runIndex({ rest: server.rest, logger, root, repo: 'demo' });

    // It took the anchor branch, and said so.
    expect(loggedInfo(logger, '用 commit 锚点跳过全量扫描')).toBe(true);

    // Only the files git reports as changed are re-extracted; the unchanged
    // one is skipped even though device B never hashed anything before.
    expect([...new Set(server.batchedFilePaths)].sort()).toEqual(['added.py', 'edited.py']);
    expect(summary.filesChanged).toBe(2);
    expect(summary.filesDeleted).toBe(1);

    // The prune set covers the deleted file AND the edited file whose stale
    // symbols live server-side from device A — but never the unchanged file.
    expect(server.prunedFilePaths).toEqual(expect.arrayContaining(['removed.py', 'edited.py']));
    expect(server.prunedFilePaths).not.toContain('stable.py');

    // The anchor advanced to c1 and stayed unique.
    const anchors = server.liveAnchors(ctxNs);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.metadata.commit).toBe(c1);
  });

  it('falls back to a full scan (and says why) when the anchor commit is unreachable here', async () => {
    const root = makeGitFixture();
    const server = makeAnchorServer();
    const ctxNs = resolveProjectHere(root).ctxNs;
    // An anchor from a line of history this checkout has never seen
    // (shallow clone / rebase / pruned branch).
    server.seedAnchor(
      ctxNs,
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      '2000-01-01T00:00:00.000Z',
    );

    const logger = fakeLogger();
    await runIndex({ rest: server.rest, logger, root, repo: 'demo' });

    expect(loggedInfo(logger, 'commit 锚点不可达')).toBe(true);
    // Degraded to a full scan: every file re-extracted, nothing silently skipped.
    expect([...new Set(server.batchedFilePaths)].sort()).toEqual([
      'edited.py',
      'removed.py',
      'stable.py',
    ]);
    // The dead anchor was replaced by this checkout's HEAD, still unique.
    const anchors = server.liveAnchors(ctxNs);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.metadata.commit).toBe(git(root, 'rev-parse', 'HEAD').trim());
  });

  it('logs why it full-scans when the server has no anchor, then writes one', async () => {
    const root = makeGitFixture();
    const server = makeAnchorServer();
    const logger = fakeLogger();

    await runIndex({ rest: server.rest, logger, root, repo: 'demo' });

    expect(loggedInfo(logger, '服务端没有可用的 commit 锚点')).toBe(true);
    const anchors = server.liveAnchors(resolveProjectHere(root).ctxNs);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.metadata.commit).toBe(git(root, 'rev-parse', 'HEAD').trim());
  });

  it('does NOT write an anchor when the symbol upload fails', async () => {
    const root = makeGitFixture();
    const server = makeAnchorServer();
    const rest = {
      request: async (req: { method: string; path: string }) => {
        if (req.method === 'POST' && req.path === '/v1/memories/batch') {
          throw new Error('request timeout after 60000ms');
        }
        return server.request(req as never);
      },
    } as unknown as RestClient;

    await expect(runIndex({ rest, logger: fakeLogger(), root, repo: 'demo' })).rejects.toThrow(
      /timeout/,
    );

    // A failed index must not advance the anchor — the next device would
    // otherwise git-diff against a commit whose symbols never made it up.
    expect(server.liveAnchors(resolveProjectHere(root).ctxNs)).toHaveLength(0);
  });
});

describe('runIndex anchor scoping + subdirectory indexing (review findings)', () => {
  /** monorepo: apps/api and apps/web in ONE git repo, therefore one ctx bucket. */
  function makeMonorepoFixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'kireo-run-index-mono-'));
    mkdirSync(join(root, 'apps', 'api'), { recursive: true });
    mkdirSync(join(root, 'apps', 'web'), { recursive: true });
    writeFileSync(join(root, 'apps', 'api', 'a.py'), 'def api_one():\n    return 1\n');
    writeFileSync(join(root, 'apps', 'web', 'w.py'), 'def web_one():\n    return 1\n');
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'kireo@test.invalid');
    git(root, 'config', 'user.name', 'kireo');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'c0');
    return root;
  }

  it('a second code bucket in the same repo still does a full scan (does not inherit the first anchor)', async () => {
    const root = makeMonorepoFixture();
    const server = makeAnchorServer();

    // `kireo index --repo api` over the whole repo: full scan, writes an anchor.
    await runIndex({
      rest: server.rest,
      logger: fakeLogger(),
      root,
      repo: 'api',
      namespace: 'code-api',
    });
    rmSync(join(root, '.kireo'), { recursive: true, force: true });
    server.batchedFilePaths.length = 0;

    // `kireo index --repo web`: same git remote → same ctx bucket → it used to
    // read code-api's anchor, git-diff HEAD..HEAD to nothing, and upload ZERO
    // symbols while logging success. code-web stayed empty forever.
    const logger = fakeLogger();
    const summary = await runIndex({
      rest: server.rest,
      logger,
      root,
      repo: 'web',
      namespace: 'code-web',
    });

    expect(loggedInfo(logger, '服务端没有可用的 commit 锚点')).toBe(true);
    expect(summary.symbols).toBeGreaterThan(0);
    expect([...new Set(server.batchedFilePaths)].sort()).toEqual([
      'apps/api/a.py',
      'apps/web/w.py',
    ]);
  });

  it('indexing a SUBDIRECTORY off an anchor uploads its symbols and prunes its real paths', async () => {
    const root = makeMonorepoFixture();
    const sub = join(root, 'apps', 'api');
    const server = makeAnchorServer();
    const ctxNs = resolveProjectHere(sub).ctxNs;
    const c0 = git(root, 'rev-parse', 'HEAD').trim();

    // Another device already indexed apps/api at c0.
    server.seedAnchor(ctxNs, c0, '2026-08-30T09:00:00.000Z', {
      codeNs: 'code-api',
      indexRoot: 'apps/api',
    });

    // Now apps/api/a.py changes and is committed.
    writeFileSync(
      join(sub, 'a.py'),
      'def api_one():\n    return 1\n\n\ndef api_two():\n    return 2\n',
    );
    git(root, 'commit', '-q', '-a', '-m', 'c1');

    const logger = fakeLogger();
    const summary = await runIndex({
      rest: server.rest,
      logger,
      root: sub,
      repo: 'api',
      namespace: 'code-api',
    });

    expect(loggedInfo(logger, '用 commit 锚点跳过全量扫描')).toBe(true);
    // git answers in repo-root-relative paths ('apps/api/a.py') while walkRepo
    // and every stored metadata.file_path are index-root-relative ('a.py').
    // Unrebased, bufByPath missed every file: zero symbols uploaded (while
    // stdout still said "1 changed"), and the prune asked the server to delete
    // 'apps/api/a.py' from a bucket holding 'a.py'.
    expect(summary.symbols).toBeGreaterThan(0);
    expect(server.batchedFilePaths).toContain('a.py');
    expect(server.batchedFilePaths).not.toContain('apps/api/a.py');
    expect(server.prunedFilePaths).toEqual(['a.py']);
    // apps/web is outside the index root and must not appear at all.
    expect(server.batchedFilePaths.some((p) => p.includes('w.py'))).toBe(false);
  });
});
