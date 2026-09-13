import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli.js';
import type { BackfillFsDeps } from '../../src/context/backfill.js';
import { type DoctorCheck, formatDoctorReport, runDoctor } from '../../src/context/doctor.js';
import { resolveProjectHere } from '../../src/context/project.js';
import { RestApiError } from '../../src/lib/errors.js';
import type { RestClient } from '../../src/rest/client.js';

// ---------------------------------------------------------------------------
// `runCli` mocks. Only the `project merge` block below drives runCli; the
// runDoctor tests inject their own fakes and touch none of these.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  startServer: vi.fn(async () => undefined),
  requests: [] as { method: string; path: string; body?: unknown }[],
  /** Per-request handler installed by each merge test. */
  handle: {
    fn: (_input: { method: string; path: string; body?: unknown }): unknown => ({}),
  },
  answer: { value: 'y' },
}));

vi.mock('../../src/server.js', () => ({ startServer: mocks.startServer }));
vi.mock('../../src/observability/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child() {
      return this;
    },
  }),
}));
vi.mock('../../src/rest/client.js', () => ({
  createRestClient: () => ({
    request: async (input: { method: string; path: string; body?: unknown }) => {
      mocks.requests.push(input);
      return mocks.handle.fn(input);
    },
  }),
}));
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: async () => mocks.answer.value,
    close: () => undefined,
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures: REAL on-disk shapes, copied from files under ~/.codex/sessions and
// ~/.claude/projects on 2026-08-31 — not invented. The retired Codex shape is
// the one this machine's March-2026 rollouts actually use; the current shape
// is the one its August-2026 rollouts use. That drift inside a single 0.14x
// minor line is the exact failure `kireo doctor` exists to surface.
// ---------------------------------------------------------------------------

const CLAUDE_CURRENT = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: '把 retry 改成指数退避' } }),
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '好的，改 retry.ts' }] },
  }),
].join('\n');

/** A plausible future Claude Code format: nothing the current parser matches. */
const CLAUDE_BROKEN = [
  JSON.stringify({ type: 'turn', role: 'user', parts: [{ kind: 'text', value: 'hi' }] }),
  JSON.stringify({ type: 'turn', role: 'assistant', parts: [{ kind: 'text', value: 'yo' }] }),
].join('\n');

const CODEX_CURRENT = [
  JSON.stringify({ type: 'session_meta', payload: { cwd: '/w/proj' } }),
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type: 'UserMessage', content: [{ type: 'text', text: '把 retry 改成指数退避' }] },
    },
  }),
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type: 'AgentMessage', content: [{ type: 'Text', text: '好的' }] },
    },
  }),
].join('\n');

/** The RETIRED Codex shape (`payload.type == 'user_message'`, no `payload.item`). */
const CODEX_RETIRED = [
  JSON.stringify({ type: 'session_meta', payload: { cwd: '/w/proj' } }),
  JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'yo' } }),
].join('\n');

const CLAUDE_DIR = '/home/.claude/projects/-w-proj';
const CODEX_DIR = '/home/.codex/sessions/2026/08/30';

/** In-memory {@link BackfillFsDeps}: directories are inferred from file paths. */
function makeFs(files: Record<string, { text: string; mtimeMs?: number }>): BackfillFsDeps {
  const dirs = new Set<string>();
  for (const p of Object.keys(files)) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (d) dirs.add(d);
    }
  }
  return {
    readDir: async (dir: string) => {
      if (!dirs.has(dir)) throw new Error(`ENOENT: ${dir}`);
      const names = new Set<string>();
      for (const p of [...Object.keys(files), ...dirs]) {
        if (!p.startsWith(`${dir}/`)) continue;
        const head = p.slice(dir.length + 1).split('/')[0];
        if (head) names.add(head);
      }
      return [...names];
    },
    stat: async (p: string) => {
      const f = files[p];
      if (f) return { isDirectory: () => false, mtimeMs: f.mtimeMs ?? 1 };
      if (dirs.has(p)) return { isDirectory: () => true, mtimeMs: 0 };
      throw new Error(`ENOENT: ${p}`);
    },
    readFile: async (p: string) => {
      const f = files[p];
      if (!f) throw new Error(`ENOENT: ${p}`);
      return f.text;
    },
  };
}

/** A RestClient double driven by a path→response map. */
function fakeRest(handler: (input: { method: string; path: string }) => unknown): RestClient {
  return {
    request: async <T>(input: { method: string; path: string }): Promise<T> => {
      const out = handler(input);
      if (out instanceof Error) throw out;
      return out as T;
    },
  } as RestClient;
}

const HEALTHY_REST = (over: Record<string, unknown> = {}): RestClient =>
  fakeRest(({ path }) => {
    if (path.startsWith('/v1/health')) return { ok: true };
    if (path.startsWith('/v1/memories')) return { items: [], next_cursor: null };
    if (path.startsWith('/v1/me')) {
      return {
        plan: 'pro',
        status: 'active',
        quotas: { writes: 5000, reads: 20000, memories: 50000 },
        usage: { writes: 10, reads: 20, memories: 30 },
      };
    }
    return over[path] ?? {};
  });

const find = (checks: DoctorCheck[], id: string): DoctorCheck => {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check with id ${id}: ${checks.map((x) => x.id).join(',')}`);
  return c;
};

describe('runDoctor — host transcript format probing', () => {
  let workspace = '';
  let outbox = '';

  const base = (fs: BackfillFsDeps, rest: RestClient | null = HEALTHY_REST()) => ({
    rest,
    cwd: workspace,
    env: {} as NodeJS.ProcessEnv,
    homeDir: '/home',
    outboxDir: outbox,
    fs,
  });

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'kireo-doctor-ws-'));
    outbox = join(mkdtempSync(join(tmpdir(), 'kireo-doctor-ob-')), 'outbox');
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('parses a REAL current transcript from each host and reports ok', async () => {
    const fs = makeFs({
      [`${CLAUDE_DIR}/s1.jsonl`]: { text: CLAUDE_CURRENT, mtimeMs: 100 },
      [`${CODEX_DIR}/r1.jsonl`]: { text: CODEX_CURRENT, mtimeMs: 100 },
    });
    const { checks } = await runDoctor(base(fs));
    expect(find(checks, 'transcript-claude-code').status).toBe('ok');
    expect(find(checks, 'transcript-claude-code').detail).toContain('2 轮');
    expect(find(checks, 'transcript-codex').status).toBe('ok');
    expect(find(checks, 'transcript-codex').detail).toContain('2 轮');
  });

  it('FAILS loudly when a host changed its on-disk shape — the retired Codex format', async () => {
    // The whole reason this command exists: nothing else in the product
    // distinguishes "the host changed its format" from "nobody said anything".
    const fs = makeFs({
      [`${CLAUDE_DIR}/s1.jsonl`]: { text: CLAUDE_CURRENT, mtimeMs: 100 },
      [`${CODEX_DIR}/r1.jsonl`]: { text: CODEX_RETIRED, mtimeMs: 100 },
    });
    const { checks, failed } = await runDoctor(base(fs));
    const codex = find(checks, 'transcript-codex');
    expect(codex.status).toBe('fail');
    // The observed line types must survive into the output — they are the
    // only actionable payload in a format-break report.
    expect(codex.detail).toContain('event_msg/user_message');
    expect(codex.detail).toContain(`${CODEX_DIR}/r1.jsonl`);
    expect(codex.hint).toContain('@kireo/mcp-server');
    expect(failed).toBeGreaterThan(0);
    // …and the other host is reported independently, not tarred with it.
    expect(find(checks, 'transcript-claude-code').status).toBe('ok');
  });

  it('FAILS when Claude Code changes shape, naming the observed row types', async () => {
    const fs = makeFs({
      [`${CLAUDE_DIR}/s1.jsonl`]: { text: CLAUDE_BROKEN, mtimeMs: 100 },
      [`${CODEX_DIR}/r1.jsonl`]: { text: CODEX_CURRENT, mtimeMs: 100 },
    });
    const { checks } = await runDoctor(base(fs));
    const claude = find(checks, 'transcript-claude-code');
    expect(claude.status).toBe('fail');
    expect(claude.detail).toContain('turn');
  });

  it('samples the NEWEST files, so one stale old-format rollout is not an alarm', async () => {
    // Real machines keep years of history: this repo's own ~/.codex holds
    // March-2026 rollouts in the retired shape next to August-2026 ones in the
    // current shape. Sampling by mtime is what keeps that from crying wolf.
    const fs = makeFs({
      [`${CODEX_DIR}/old.jsonl`]: { text: CODEX_RETIRED, mtimeMs: 1 },
      [`${CODEX_DIR}/new.jsonl`]: { text: CODEX_CURRENT, mtimeMs: 999 },
    });
    const { checks } = await runDoctor(base(fs));
    expect(find(checks, 'transcript-codex').status).toBe('ok');
    expect(find(checks, 'transcript-codex').detail).toContain('new.jsonl');
  });

  it('does not call an empty live session a format break', async () => {
    const fs = makeFs({
      [`${CODEX_DIR}/r1.jsonl`]: { text: '', mtimeMs: 100 },
    });
    const { checks } = await runDoctor(base(fs));
    expect(find(checks, 'transcript-codex').status).toBe('warn');
    expect(find(checks, 'transcript-codex').status).not.toBe('fail');
  });

  it('skips a host that has never run on this machine', async () => {
    const fs = makeFs({ [`${CLAUDE_DIR}/s1.jsonl`]: { text: CLAUDE_CURRENT } });
    const { checks } = await runDoctor(base(fs));
    expect(find(checks, 'transcript-codex').status).toBe('skip');
  });
});

describe('runDoctor — the other silent failures', () => {
  let workspace = '';
  let outbox = '';
  const fs = makeFs({ [`${CLAUDE_DIR}/s1.jsonl`]: { text: CLAUDE_CURRENT } });

  const base = (over: Partial<Parameters<typeof runDoctor>[0]> = {}) => ({
    rest: HEALTHY_REST(),
    cwd: workspace,
    env: {} as NodeJS.ProcessEnv,
    homeDir: '/home',
    outboxDir: outbox,
    fs,
    ...over,
  });

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'kireo-doctor-ws-'));
    outbox = join(mkdtempSync(join(tmpdir(), 'kireo-doctor-ob-')), 'outbox');
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('names the resolved project identity and warns when it is machine-local', async () => {
    // A bare temp dir is not a git repo, so the key falls back to the
    // basename — the resolution that silently forks a project across devices.
    const { checks } = await runDoctor(base());
    const project = find(checks, 'project');
    expect(project.status).toBe('warn');
    expect(project.detail).toContain('来源=basename');
    expect(project.detail).toContain('ctx 桶');
    expect(project.hint).toContain('kireo project init');
  });

  it('reports the kill switch, because it makes context_save a silent no-op', async () => {
    mkdirSync(join(workspace, '.kireo'), { recursive: true });
    writeFileSync(join(workspace, '.kireo', 'disabled'), '');
    const { checks } = await runDoctor(base());
    expect(find(checks, 'kill-switch').status).toBe('warn');
    expect(find(checks, 'kill-switch').detail).toContain('.kireo/disabled');
  });

  it('reports the kill switch from the env var too', async () => {
    const { checks } = await runDoctor(base({ env: { KIREO_DISABLED: '1' } }));
    expect(find(checks, 'kill-switch').detail).toContain('KIREO_DISABLED');
  });

  it('does not imply resume still works while the switch is on', async () => {
    // The line used to read "context_save 不会做任何事" and stop there, which
    // reads as "…but resume is fine". It is not: context_load returns before
    // the outbox flush, and every outbound CLI command stops at the same gate.
    // doctor exists to answer "why did nothing happen", so a detail that names
    // only half the effect is the one failure it cannot afford.
    const { checks } = await runDoctor(base({ env: { KIREO_DISABLED: '1' } }));
    const detail = find(checks, 'kill-switch').detail;
    expect(detail).toContain('resume');
    expect(detail).toContain('index');
    expect(detail).toContain('backfill');
  });

  it('stops promising an automatic outbox retry that the switch has disabled', async () => {
    // "下一次 save 或 resume 开头会自动重传" is false while the kill switch is
    // on — both return before the flush — so a user with a backlog would be
    // told to wait for a retry that structurally cannot happen.
    mkdirSync(outbox, { recursive: true });
    writeFileSync(join(outbox, '0.json'), JSON.stringify({ ts: '', namespace: '', entries: [] }));
    const on = find((await runDoctor(base({ env: { KIREO_DISABLED: '1' } }))).checks, 'outbox');
    expect(on.hint).toContain('不会自动重传');
    const off = find((await runDoctor(base())).checks, 'outbox');
    expect(off.hint).toContain('自动重传');
    expect(off.hint).not.toContain('不会自动重传');
  });

  it('escalates an outbox backlog from warn to fail', async () => {
    mkdirSync(outbox, { recursive: true });
    for (let i = 0; i < 3; i++) {
      writeFileSync(
        join(outbox, `${i}.json`),
        JSON.stringify({ ts: '', namespace: '', entries: [] }),
      );
    }
    expect(find((await runDoctor(base())).checks, 'outbox').status).toBe('warn');
    for (let i = 3; i < 25; i++) {
      writeFileSync(
        join(outbox, `${i}.json`),
        JSON.stringify({ ts: '', namespace: '', entries: [] }),
      );
    }
    const backlogged = find((await runDoctor(base())).checks, 'outbox');
    expect(backlogged.status).toBe('fail');
    expect(backlogged.detail).toContain('25 批');
  });

  it('fails on a rejected API key and skips the quota line rather than guessing', async () => {
    const rest = fakeRest(({ path }) => {
      if (path.startsWith('/v1/health')) return { ok: true };
      if (path.startsWith('/v1/memories')) return { items: [], next_cursor: null };
      if (path.startsWith('/v1/me')) {
        return new RestApiError({ code: 'AUTH_INVALID_KEY', message: 'bad key' }, 401);
      }
      return {};
    });
    const { checks } = await runDoctor(base({ rest }));
    expect(find(checks, 'auth').status).toBe('fail');
    expect(find(checks, 'auth').hint).toContain('api-keys');
    expect(find(checks, 'quota').status).toBe('skip');
  });

  it('warns before the write quota runs out, not after', async () => {
    const rest = fakeRest(({ path }) => {
      if (path.startsWith('/v1/health')) return { ok: true };
      if (path.startsWith('/v1/memories')) return { items: [], next_cursor: null };
      if (path.startsWith('/v1/me')) {
        return {
          plan: 'free',
          status: 'active',
          quotas: { writes: 100, reads: 200, memories: 200 },
          usage: { writes: 95, reads: 10, memories: 12 },
        };
      }
      return {};
    });
    const quota = find((await runDoctor(base({ rest }))).checks, 'quota');
    expect(quota.status).toBe('warn');
    expect(quota.detail).toContain('95/100');
    expect(quota.hint).toContain('outbox');
  });

  it('catches a list-endpoint envelope change — the readers degrade to "empty", not to an error', async () => {
    // The server answers under `items` (apps/api/src/memory/service.ts
    // #ListResult) and every relay reader now dereferences `items`. This case
    // simulates the API moving the array somewhere else. It used to assert the
    // exact inverse — EXPECTED_LIST_KEY was `'data'`, so this check would have
    // reported `fail` on its very first run against the real production API,
    // and the "wrong" fixture below was the real shape.
    const rest = fakeRest(({ path }) => {
      if (path.startsWith('/v1/health')) return { ok: true };
      if (path.startsWith('/v1/memories')) return { data: [{ id: 'm1' }], next_cursor: null };
      return {};
    });
    const envelope = find((await runDoctor(base({ rest }))).checks, 'list-envelope');
    expect(envelope.status).toBe('fail');
    expect(envelope.detail).toContain('data');
    expect(envelope.hint).toContain('context-load.ts');
  });

  it('passes the envelope check against the REAL server shape', async () => {
    const rest = fakeRest(({ path }) => {
      if (path.startsWith('/v1/health')) return { ok: true };
      if (path.startsWith('/v1/memories')) return { items: [{ id: 'm1' }], next_cursor: null };
      return {};
    });
    const envelope = find((await runDoctor(base({ rest }))).checks, 'list-envelope');
    expect(envelope.status).toBe('ok');
  });

  it('ages the code-index anchor and fails when it is a month stale', async () => {
    const anchor = (occurredAt: string) =>
      fakeRest(({ path }) => {
        if (path.startsWith('/v1/health')) return { ok: true };
        if (!path.startsWith('/v1/memories')) return {};
        return {
          items: [
            {
              id: 'h1',
              tags: ['k-index-head'],
              occurred_at: occurredAt,
              // Anchors are scoped to the (code bucket, index root) they
              // describe; doctor asks for the bucket `kireo index` writes here.
              metadata: {
                commit: 'abcdef1234567890',
                code_ns: resolveProjectHere(workspace).codeNs,
                index_root: resolveProjectHere(workspace).indexRoot,
              },
            },
          ],
          next_cursor: null,
        };
      });
    const now = new Date('2026-08-31T00:00:00.000Z');
    const fresh = find(
      (await runDoctor(base({ rest: anchor('2026-08-30T00:00:00.000Z'), now }))).checks,
      'index-head',
    );
    expect(fresh.status).toBe('ok');
    expect(fresh.detail).toContain('abcdef123456');

    const stale = find(
      (await runDoctor(base({ rest: anchor('2026-06-01T00:00:00.000Z'), now }))).checks,
      'index-head',
    );
    expect(stale.status).toBe('fail');
    expect(stale.hint).toContain('kireo index');
  });

  it('treats a missing API key as a finding, still runs every local check', async () => {
    const { checks } = await runDoctor(
      base({ rest: null, configError: 'KIREO_API_KEY too short' }),
    );
    expect(find(checks, 'config').status).toBe('fail');
    // Network checks degrade to skip — a missing key is not an outage…
    for (const id of ['api', 'auth', 'quota', 'list-envelope', 'index-head']) {
      expect(find(checks, id).status).toBe('skip');
    }
    // …and the checks that need no key still ran.
    expect(find(checks, 'transcript-claude-code').status).toBe('ok');
    expect(find(checks, 'project').status).not.toBe('skip');
  });

  it('renders every check into the printed report', async () => {
    const report = await runDoctor(base());
    const text = formatDoctorReport(report);
    for (const c of report.checks) expect(text).toContain(c.title);
    expect(text).toContain('kireo doctor');
  });
});

// ---------------------------------------------------------------------------
// `kireo project merge`
// ---------------------------------------------------------------------------

describe('kireo project merge', () => {
  let originalExitCode: number | string | undefined;
  const env = { KIREO_API_KEY: 'ki_sk_abcdef12' };

  function captureStdout(): { calls: string[]; restore: () => void } {
    const calls: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      calls.push(String(chunk));
      return true;
    });
    return { calls, restore: () => spy.mockRestore() };
  }
  function captureStderr(): { calls: string[]; restore: () => void } {
    const calls: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      calls.push(String(chunk));
      return true;
    });
    return { calls, restore: () => spy.mockRestore() };
  }

  const namespaceList = (items: { name: string; count: number }[]) => ({ items });

  beforeEach(() => {
    mocks.requests.length = 0;
    mocks.answer.value = 'y';
    originalExitCode = process.exitCode;
  });
  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('REFUSES a bucket bigger than the safe ceiling instead of half-migrating it', async () => {
    // The server path is one non-transactional shot with no resume and no
    // rollback (see MERGE_MAX_MEMORIES in cli.ts) — the honest answer at this
    // size is "no", not an optimistic PATCH.
    mocks.handle.fn = () => namespaceList([{ name: 'ctx-a-111111', count: 12_000 }]);
    const err = captureStderr();
    await runCli({ argv: ['project', 'merge', 'ctx-a-111111', 'ctx-b-222222', '--yes'], env });
    err.restore();
    const text = err.calls.join('');
    expect(text).toContain('拒绝执行');
    expect(text).toContain('12000');
    expect(text).toContain('不回滚');
    // Nothing was attempted beyond the read-only preflight.
    expect(mocks.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

  it('registers a memory-derived source namespace after a 404, then retries once', async () => {
    // Every bucket this feature creates (ctx-*, code-*, kireo-home) is written
    // by POST /v1/memories, which never inserts a `namespaces` row — so the
    // rename endpoint 404s on all of them until the name is registered.
    let patchCalls = 0;
    mocks.handle.fn = (input) => {
      if (input.method === 'GET' && input.path === '/v1/namespaces') {
        return namespaceList([
          { name: 'ctx-a-111111', count: 12 },
          { name: 'ctx-b-222222', count: 3 },
        ]);
      }
      if (input.method === 'PATCH') {
        patchCalls++;
        if (patchCalls === 1) {
          throw new RestApiError({ code: 'NAMESPACE_NOT_FOUND', message: 'source not found' }, 404);
        }
        return { task_id: 'task_1', status: 'pending' };
      }
      if (input.path.startsWith('/v1/async-tasks/')) return { status: 'succeeded' };
      return {};
    };
    const out = captureStdout();
    await runCli({ argv: ['project', 'merge', 'ctx-a-111111', 'ctx-b-222222', '--yes'], env });
    out.restore();

    const paths = mocks.requests.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('POST /v1/namespaces');
    expect(patchCalls).toBe(2);
    expect(out.calls.join('')).toContain('完成');
    expect(process.exitCode).toBeUndefined();
  });

  it('explains that the endpoint is a rename when the target is already registered', async () => {
    mocks.handle.fn = (input) => {
      if (input.method === 'GET' && input.path === '/v1/namespaces') {
        return namespaceList([
          { name: 'ctx-a-111111', count: 12 },
          { name: 'ctx-b-222222', count: 3 },
        ]);
      }
      if (input.method === 'PATCH') {
        throw new RestApiError({ code: 'NAMESPACE_ALREADY_EXISTS', message: 'target exists' }, 409);
      }
      return {};
    };
    const err = captureStderr();
    await runCli({ argv: ['project', 'merge', 'ctx-a-111111', 'ctx-b-222222', '--yes'], env });
    err.restore();
    expect(err.calls.join('')).toContain('本质是"改名"');
    expect(process.exitCode).toBe(1);
  });

  it('surfaces a failed server task as unrecovered divergence, not as "done"', async () => {
    mocks.handle.fn = (input) => {
      if (input.method === 'GET' && input.path === '/v1/namespaces') {
        return namespaceList([{ name: 'ctx-a-111111', count: 12 }]);
      }
      if (input.method === 'PATCH') return { task_id: 'task_2' };
      if (input.path.startsWith('/v1/async-tasks/')) {
        return { status: 'failed', error: { code: 'INTERNAL', message: 'lance blew up' } };
      }
      return {};
    };
    const err = captureStderr();
    await runCli({ argv: ['project', 'merge', 'ctx-a-111111', 'ctx-b-222222', '--yes'], env });
    err.restore();
    const text = err.calls.join('');
    expect(text).toContain('没有回滚');
    expect(text).toContain('lance blew up');
    expect(process.exitCode).toBe(1);
  });

  it('does nothing when the confirmation is declined', async () => {
    mocks.answer.value = 'n';
    mocks.handle.fn = () => namespaceList([{ name: 'ctx-a-111111', count: 12 }]);
    const out = captureStdout();
    await runCli({ argv: ['project', 'merge', 'ctx-a-111111', 'ctx-b-222222'], env });
    out.restore();
    expect(out.calls.join('')).toContain('已取消');
    expect(mocks.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
  });

  it('refuses an unknown source namespace and lists the real ones', async () => {
    mocks.handle.fn = () => namespaceList([{ name: 'ctx-real-999999', count: 4 }]);
    const err = captureStderr();
    await runCli({ argv: ['project', 'merge', 'ctx-typo-000000', 'ctx-b-222222', '--yes'], env });
    err.restore();
    expect(err.calls.join('')).toContain('ctx-real-999999');
    expect(process.exitCode).toBe(1);
  });
});
