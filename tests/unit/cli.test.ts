import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ctxNamespace } from '@kireo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KNOWN_COMMANDS, runCli, writeKireoGitignore } from '../../src/cli.js';
import { resolveProjectHere } from '../../src/context/project.js';

const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

interface CapturedRequest {
  method: string;
  path: string;
  body?: { content?: string; namespace?: string };
}

const mocks = vi.hoisted(() => ({
  startServer: vi.fn(async () => undefined),
  /** Fake $HOME, repointed per test so the backfill scan never sees the real one. */
  home: { dir: '' },
  requests: [] as {
    method: string;
    path: string;
    body?: { content?: string; namespace?: string };
  }[],
  /** What the confirmation prompt answers; overridden per test. */
  answer: { value: 'y' },
  /** When set, every upload rejects with it — the 429/503 case. */
  uploadError: { value: null as Error | null },
  /** How many REST clients were constructed — the kill switch must gate BEFORE this. */
  clients: { n: 0 },
  /** What `GET /v1/namespaces` answers, for the bucket-migration cases. */
  namespaces: { value: [] as { name: string; count: number }[] },
  /** Namespaces whose PATCH (rename) is rejected — the partial-migration case. */
  patchFails: { value: [] as string[] },
}));
vi.mock('../../src/server.js', () => ({ startServer: mocks.startServer }));

// The backfill branch walks `homeDir()`; point it at a throwaway directory so
// these tests read real files (exercising cli.ts's own fs wiring) without ever
// touching the developer's own ~/.claude. Every other platform path is
// redirected into the same sandbox so no test can read or write the real
// ~/.kireo either.
vi.mock('../../src/lib/platform.js', () => ({
  homeDir: () => mocks.home.dir,
  configDir: () => join(mocks.home.dir, '.kireo'),
  configFile: () => join(mocks.home.dir, '.kireo', 'config.json'),
  logsDir: () => join(mocks.home.dir, '.kireo', 'logs'),
  cacheDir: () => join(mocks.home.dir, '.kireo', 'cache'),
  fallbackTmpDir: () => join(mocks.home.dir, 'tmp'),
}));

// pino's real transport spawns a worker thread and a log file; neither is under
// test here.
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
  createRestClient: () => {
    // Counted, not just recorded: the kill switch has to stop a command BEFORE
    // it can build a client, not merely before it uses one.
    mocks.clients.n += 1;
    return {
      request: async (input: { method: string; path: string; body?: Record<string, unknown> }) => {
        mocks.requests.push({
          method: input.method,
          path: input.path,
          ...(input.body === undefined
            ? {}
            : { body: input.body as { content?: string; namespace?: string } }),
        });
        if (mocks.uploadError.value) throw mocks.uploadError.value;
        if (input.method === 'GET' && input.path === '/v1/namespaces') {
          return { items: mocks.namespaces.value };
        }
        if (input.method === 'PATCH' && input.path.startsWith('/v1/namespaces/')) {
          const from = decodeURIComponent(input.path.slice('/v1/namespaces/'.length));
          if (mocks.patchFails.value.includes(from)) throw new Error(`rename rejected: ${from}`);
          return { task_id: `task-${from}` };
        }
        if (input.method === 'GET' && input.path.startsWith('/v1/async-tasks/')) {
          return { status: 'succeeded' };
        }
        return {};
      },
    };
  },
}));

vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: async () => mocks.answer.value,
    close: () => undefined,
  }),
}));

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runCli help/version (BUG-004)', () => {
  it('`--help` prints usage to stdout, needs no API key, no side effects', async () => {
    const out = captureStdout();
    // Empty env: if this fell through to loadConfig/startServer it would throw.
    await runCli({ argv: ['--help'], env: {} });
    out.restore();
    const text = out.calls.join('');
    expect(text).toContain('kireo index');
    expect(text).toContain('--timeout');
    expect(text).toContain('--batch-size');
    expect(text).toContain('--repo');
    expect(text).toContain('KIREO_API_KEY');
  });

  it('`index --help` shows help instead of indexing the cwd', async () => {
    const out = captureStdout();
    await runCli({ argv: ['index', '--help'], env: {} });
    out.restore();
    const text = out.calls.join('');
    expect(text).toContain('kireo index');
    // Must NOT have performed an index (no "Indexed ... -> namespace" line).
    expect(text).not.toContain('-> namespace');
  });

  it('`--version` prints the version and nothing else', async () => {
    const out = captureStdout();
    await runCli({ argv: ['--version'], env: {} });
    out.restore();
    expect(out.calls.join('')).toMatch(/\d+\.\d+\.\d+/);
  });
});

describe('runCli index flag validation (BUG-004 / BUG-001)', () => {
  const env = { KIREO_API_KEY: 'ki_sk_abcdef12' };

  it('rejects an unknown flag with exit-worthy error + usage hint, without indexing', async () => {
    await expect(runCli({ argv: ['index', '--bogus'], env })).rejects.toThrow(
      /unknown flag "--bogus"/,
    );
    await expect(runCli({ argv: ['index', '--bogus'], env })).rejects.toThrow(/kireo --help/);
  });

  it('rejects an out-of-range --batch-size', async () => {
    await expect(runCli({ argv: ['index', '--batch-size', '0'], env })).rejects.toThrow(
      /invalid --batch-size/,
    );
    await expect(runCli({ argv: ['index', '--batch-size', '200'], env })).rejects.toThrow(
      /invalid --batch-size/,
    );
    await expect(runCli({ argv: ['index', '--batch-size', 'abc'], env })).rejects.toThrow(
      /invalid --batch-size/,
    );
  });
});

describe('subcommand dispatch', () => {
  let originalExit: number | string | undefined;
  beforeEach(() => {
    originalExit = process.exitCode;
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = originalExit;
  });

  it('does NOT fall back to the stdio server for a known subcommand', async () => {
    // Regression: cli.ts used to route every non-"index" argv to startServer,
    // so a typo'd or not-yet-implemented subcommand hung as an MCP server
    // instead of erroring. Known commands must never reach startServer.
    //
    // NOTE `doctor` is IMPLEMENTED, so this case never touches the
    // not-implemented branch at all — it only proves the doctor branch exists.
    // The two cases below are the ones that actually cover dispatch.
    const err = captureStderr();
    await expect(runCli({ argv: ['doctor'] })).resolves.toBeUndefined();
    err.restore();
    expect(mocks.startServer).not.toHaveBeenCalled();
  });

  it('a KNOWN-but-unimplemented subcommand errors with a message and exit 1', async () => {
    const err = captureStderr();
    await runCli({ argv: ['ctx', 'save'] });
    err.restore();
    expect(mocks.startServer).not.toHaveBeenCalled();
    expect(err.calls.join('')).toContain('subcommand "ctx" is not implemented yet');
    expect(process.exitCode).toBe(1);
  });

  it('a TYPO must error too — it used to hang silently as an MCP server', async () => {
    // `kireo idnex .` printed nothing, exited never, and sat waiting for MCP
    // frames on stdin until Ctrl-C: KNOWN_COMMANDS only caught commands that
    // were listed-but-unimplemented, so every misspelling fell through to
    // startServer. spec §12.2 requires that no subcommand falls back to the
    // server; cli.ts's own comment calls this the worst possible CLI failure.
    for (const typo of ['idnex', 'resmue']) {
      mocks.startServer.mockClear();
      process.exitCode = undefined;
      const err = captureStderr();
      await runCli({ argv: [typo, '.'] });
      err.restore();
      expect(mocks.startServer).not.toHaveBeenCalled();
      expect(err.calls.join('')).toContain(`unknown subcommand "${typo}"`);
      expect(err.calls.join('')).toContain('kireo --help');
      expect(process.exitCode).toBe(1);
    }
  });

  it('still starts the stdio server when given no argv', async () => {
    await runCli({ argv: [] });
    expect(mocks.startServer).toHaveBeenCalledTimes(1);
  });

  it('still starts the stdio server for a leading flag (how hosts launch it)', async () => {
    // Hosts run `kireo --api-key … --namespace …`; those must keep reaching
    // startServer, where loadConfig validates them.
    await runCli({
      argv: ['--namespace', 'default'],
      env: { KIREO_API_KEY: 'ki_sk_live_abcdef12' },
    });
    expect(mocks.startServer).toHaveBeenCalledTimes(1);
  });
});

describe('runCli backfill privacy gate + upload fault tolerance', () => {
  // A credential shape redact.ts explicitly covers, planted in "history".
  const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
  const env = { KIREO_API_KEY: 'ki_sk_live_abcdef12' };
  let home = '';
  let originalExitCode: number | string | undefined;

  const claudeTurn = (role: 'user' | 'assistant', text: string) =>
    JSON.stringify({ type: role, message: { role, content: text } });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kireo-backfill-cli-'));
    mocks.home.dir = home;
    mocks.requests.length = 0;
    mocks.answer.value = 'y';
    mocks.uploadError.value = null;
    originalExitCode = process.exitCode;
  });

  afterEach(() => {
    // Never let a deliberate exit-1 assertion leak into the test runner's own
    // exit status.
    process.exitCode = originalExitCode;
    rmSync(home, { recursive: true, force: true });
  });

  /**
   * Write `n` Claude sessions into the fake home; session 0 carries the secret.
   *
   * Every transcript records its absolute `cwd`, exactly like a real one does
   * (Claude Code puts it on its rows, Codex under `payload.cwd`). That field is
   * the ONLY thing the per-project kill switch can key on, so a fixture without
   * it is not a realistic session — it is the "cannot identify this project"
   * case, which is deliberately skipped and has its own test below.
   */
  function seedSessions(n: number, projectDir = join(home, 'proj'), slug = '-home-u-proj'): void {
    mkdirSync(projectDir, { recursive: true });
    const dir = join(home, '.claude', 'projects', slug);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i++) {
      writeFileSync(
        join(dir, `s${i}.jsonl`),
        [
          JSON.stringify({ type: 'summary', cwd: projectDir }),
          claudeTurn('user', i === 0 ? `deploy with ${SECRET} please` : `session ${i} question`),
          claudeTurn('assistant', `session ${i} answer`),
        ].join('\n'),
      );
    }
  }

  const contents = (): string[] =>
    (mocks.requests as CapturedRequest[]).map((r) => r.body?.content ?? '');

  it('prints the REDACTED body — byte-identical to what it then uploads', async () => {
    seedSessions(1);
    const out = captureStdout();
    await runCli({ argv: ['backfill', '--dry-run=false'], env });
    out.restore();
    const text = out.calls.join('');

    // 1. The plaintext credential never reaches the terminal (nor the shell
    //    scrollback the user keeps around afterwards).
    expect(text).not.toContain(SECRET);
    expect(text).toContain('[REDACTED]');
    // 2. …and the promise made right under the preview is therefore true.
    expect(text).toContain('已做已知凭据脱敏');

    // 3. What was approved is what was sent — same bytes, not merely "similar".
    expect(mocks.requests).toHaveLength(1);
    const sent = contents()[0] ?? '';
    expect(sent).not.toContain(SECRET);
    expect(sent).toContain('[REDACTED]');
    expect(text).toContain(sent);
  });

  it('uploads nothing when the confirmation is declined', async () => {
    seedSessions(1);
    mocks.answer.value = 'n';
    const out = captureStdout();
    await runCli({ argv: ['backfill', '--dry-run=false'], env });
    out.restore();
    expect(out.calls.join('')).toContain('已取消');
    expect(mocks.requests).toHaveLength(0);
  });

  it('never prints or sends anything under the default dry-run', async () => {
    seedSessions(1);
    const out = captureStdout();
    await runCli({ argv: ['backfill'], env });
    out.restore();
    expect(mocks.requests).toHaveLength(0);
    expect(out.calls.join('')).not.toContain(SECRET);
  });

  it('the kill switch stops backfill dead — it is the biggest outbound path', async () => {
    // `.kireo/disabled` / KIREO_DISABLED is documented as "kireo stops sending
    // anything out", but only context_save consulted it. backfill walks EVERY
    // project under ~/.claude/projects and ~/.codex/sessions and uploads raw
    // session text, not distilled cards — so a user who set the switch in a
    // confidential repo and ran `kireo backfill --dry-run=false` shipped that
    // repo's sessions anyway.
    seedSessions(2);
    const out = captureStdout();
    await runCli({ argv: ['backfill', '--dry-run=false'], env: { ...env, KIREO_DISABLED: '1' } });
    out.restore();
    expect(mocks.requests).toHaveLength(0);
    expect(out.calls.join('')).toContain('隐私开关已启用');
    // Not even a scan: nothing was read, nothing was previewed.
    expect(out.calls.join('')).not.toContain(SECRET);
  });

  it("honours EACH project's kill switch, not just the one you happen to stand in", async () => {
    // The scenario the outer check cannot cover: `cd ~ && kireo backfill
    // --dry-run=false`. There is no "current project" at $HOME, while the scan
    // walks EVERY project under ~/.claude/projects and ~/.codex/sessions and
    // uploads raw session text. Deciding the kill switch once from
    // `process.cwd()` meant a confidential repo's months of transcripts went
    // out with its own `.kireo/disabled` sitting right there, unread — the
    // comment above that check described this exact failure while the
    // implementation checked the wrong directory.
    const CONFIDENTIAL = '并购标的的报价是 3.2 亿';
    const writeSession = (projectDir: string, slug: string, text: string) => {
      mkdirSync(projectDir, { recursive: true });
      const dir = join(home, '.claude', 'projects', slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 's.jsonl'),
        [
          JSON.stringify({ type: 'summary', cwd: projectDir }),
          claudeTurn('user', text),
          claudeTurn('assistant', 'ok'),
        ].join('\n'),
      );
    };

    const secretDir = join(home, 'confidential');
    mkdirSync(join(secretDir, '.kireo'), { recursive: true });
    writeFileSync(join(secretDir, '.kireo', 'disabled'), '');
    writeSession(secretDir, '-x-confidential', CONFIDENTIAL);
    const openDir = join(home, 'openproj');
    writeSession(openDir, '-x-open', 'ordinary session, nothing secret');

    const out = captureStdout();
    // env deliberately carries NO KIREO_DISABLED, and cwd is the test runner's
    // own directory — the only marker in play is the one inside secretDir.
    await runCli({ argv: ['backfill', '--dry-run=false'], env });
    out.restore();
    const text = out.calls.join('');

    // 1. Exactly one upload, and it is the project that never opted out.
    expect(mocks.requests).toHaveLength(1);
    expect(contents()[0]).toContain('ordinary session');
    expect((mocks.requests[0] as { body?: { namespace?: string } }).body?.namespace).toBe(
      resolveProjectHere(openDir).ctxNs,
    );
    // 2. The disabled project's text neither left the device…
    expect(contents().join('')).not.toContain(CONFIDENTIAL);
    // 3. …nor got dumped into the confirmation preview on the way.
    expect(text).not.toContain(CONFIDENTIAL);
    // 4. And the run says what it withheld, instead of quietly doing less.
    expect(text).toContain('跳过 1 个（隐私开关）');
    expect(text).toContain(secretDir);
  });

  it('skips a session whose project it cannot identify, rather than sending it', async () => {
    // Fail-safe half. This transcript records no cwd anywhere, and the
    // directory slug is lossy (`/Users/me/项目` → `-Users-me-`), so there is no
    // directory whose `.kireo/disabled` could be read. Guessing `/Users/me/`
    // would consult a different project entirely; "cannot tell" therefore
    // means skip, not send.
    const dir = join(home, '.claude', 'projects', '-Users-me-');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'nocwd.jsonl'),
      [claudeTurn('user', `secret ${SECRET}`), claudeTurn('assistant', 'ok')].join('\n'),
    );

    const out = captureStdout();
    await runCli({ argv: ['backfill', '--dry-run=false'], env });
    out.restore();
    const text = out.calls.join('');

    expect(mocks.requests).toHaveLength(0);
    expect(text).toContain('无法确认所属项目');
    // Names the file, so the user can judge for themselves rather than
    // wondering what silently vanished.
    expect(text).toContain('nocwd.jsonl');
  });

  it('records every backfill upload in the outbound audit log', async () => {
    // spec §10.2 requires a local append-only record of what left the device.
    // appendOutboundAudit's only caller was context_save, so the single
    // largest volume of outbound content wrote nothing at all.
    seedSessions(2);
    const out = captureStdout();
    await runCli({ argv: ['backfill', '--dry-run=false'], env });
    out.restore();
    const audit = join(home, '.kireo', 'logs', 'outbound.jsonl');
    expect(existsSync(audit)).toBe(true);
    const lines = readFileSync(audit, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const rec = JSON.parse(lines[0] as string) as { namespace: string; digests: string[] };
    expect(rec.namespace).toMatch(/^ctx-/);
    // Summary only — never the content itself.
    expect(lines.join('')).not.toContain(SECRET);
  });

  it('files a session under the project its transcript actually ran in', async () => {
    // `ctxNamespace(cwdSlug)` can NEVER equal the bucket that project's resume
    // reads: the h6 suffix is sha256 of the canonical project key, and
    // `-home-u-proj` is not that key. Not "no guarantee" — a guaranteed
    // mismatch, i.e. every backfill upload was write-only: quota and storage
    // spent, namespaces created against the free plan's cap of 3, and nothing
    // readable from anywhere.
    const projectDir = join(home, 'realproj');
    mkdirSync(projectDir, { recursive: true });
    const dir = join(home, '.claude', 'projects', '-somewhere-else');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 's0.jsonl'),
      [
        JSON.stringify({ type: 'summary', cwd: projectDir }),
        claudeTurn('user', 'hello'),
        claudeTurn('assistant', 'hi'),
      ].join('\n'),
    );

    await runCli({ argv: ['backfill', '--dry-run=false'], env });
    expect(mocks.requests).toHaveLength(1);
    const ns = (mocks.requests[0] as { body?: { namespace?: string } }).body?.namespace;
    expect(ns).toBe(resolveProjectHere(projectDir).ctxNs);
    // …and specifically NOT the cwd-slug bucket it used to compute.
    expect(ns).not.toBe(ctxNamespace('-somewhere-else', sha256Hex));
  });

  it('survives a failing upload: reports it, exits non-zero, and does not throw', async () => {
    seedSessions(3);
    mocks.uploadError.value = new Error('429 Too Many Requests');
    const out = captureStdout();
    // The whole point: no `[kireo] fatal:` — runCli resolves.
    await expect(runCli({ argv: ['backfill', '--dry-run=false'], env })).resolves.toBeUndefined();
    out.restore();
    const text = out.calls.join('');

    // All three were attempted rather than the first failure killing the run.
    expect(mocks.requests).toHaveLength(3);
    expect(text).toContain('处理 0 个会话');
    expect(text).toContain('3 个上传失败');
    expect(text).toContain('429 Too Many Requests');
    // A run where nothing landed must not look like success to a script.
    expect(process.exitCode).toBe(1);
  });
});

describe('kireo project init discloses the code-bucket switch (regression)', () => {
  // Writing .kireo/project.json PINS the key, and `resolveProjectHere` hands
  // `kireo index` the hash-suffixed bucket as soon as the key is pinned. So a
  // bare `kireo project init` — which people run just to fix their project
  // identity — repoints the code index at a brand-new empty namespace. The
  // init output said nothing about it, and `codeNsMigrationHint` goes null the
  // instant the key is pinned, so nothing would ever mention it again either:
  // the user simply finds their code index gone on the next resume.
  let dir = '';
  let originalCwd = '';

  beforeEach(() => {
    originalCwd = process.cwd();
    // realpathSync: on macOS /var/folders/... is a symlink to /private/var/...,
    // and `git rev-parse --show-toplevel`-style comparisons resolve both sides.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'kireo-init-bucket-')));
    // A real git repo: `resolveProjectKey` only consults
    // `<repoRoot>/.kireo/project.json` when there IS a repo root, so outside
    // git the marker file is written and then ignored — and the bucket switch
    // this block is about would never happen.
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('names the old bucket, the new bucket, and says symbols do NOT move', async () => {
    const before = resolveProjectHere(dir);
    const out = captureStdout();
    await runCli({ argv: ['project', 'init'], env: {} });
    out.restore();
    const after = resolveProjectHere(dir);

    // The switch really is silent-by-default — this is what has to be disclosed.
    expect(after.codeNs).not.toBe(before.codeNs);
    // …and it kills the only mechanism that used to mention the old bucket.
    expect(after.codeNsMigrationHint).toBeNull();

    const text = out.calls.join('');
    expect(text).toContain(before.codeNs);
    expect(text).toContain(after.codeNs);
    expect(text).toContain('不会自动搬过去');
    expect(text).toContain('kireo project init --migrate');
    // No local index state here, so the stale-state paragraph must stay out of
    // the way (see the next case).
    expect(text).not.toContain('一个符号也不会补进新桶');
  });

  it('warns that a stale index-state.json leaves the NEW bucket empty forever', async () => {
    // index-state.json is keyed by file path only — it has no idea which
    // namespace those hashes went to. After the switch, `kireo index` diffs
    // against it, concludes "nothing changed", uploads zero symbols, and
    // prints a perfectly healthy summary over an empty bucket.
    mkdirSync(join(dir, '.kireo'), { recursive: true });
    writeFileSync(join(dir, '.kireo', 'index-state.json'), '{"a.ts":"deadbeef"}\n');

    const out = captureStdout();
    await runCli({ argv: ['project', 'init'], env: {} });
    out.restore();

    const text = out.calls.join('');
    // Deliberately NOT matching on '什么都没变' alone: the pre-existing
    // "don't commit index-state.json" paragraph already contains that phrase,
    // so a loose assertion here would pass even with the disclosure removed.
    expect(text).toContain('一个符号也不会补进新桶');
    expect(text).toContain('删掉 .kireo/index-state.json');
  });

  it('says nothing about buckets when nothing changed', async () => {
    // Second `init` in the same directory: already pinned, same bucket. A
    // warning here would be noise, and noise is how real warnings get ignored.
    await runCli({ argv: ['project', 'init'], env: {} });
    const out = captureStdout();
    await runCli({ argv: ['project', 'init'], env: {} });
    out.restore();
    expect(out.calls.join('')).not.toContain('code 桶');
  });
});

describe('kireo project init writes a .kireo/.gitignore (review finding)', () => {
  let dir = '';
  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'kireo-proj-init-')), '.kireo');
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

  it('ignores the machine-local files that share the directory with project.json', async () => {
    // `project init` tells the user to commit `.kireo/`. The same directory
    // also holds index-state.json (this machine's path→sha256 map) and
    // CONTEXT.md. Committing index-state.json is actively destructive: a
    // teammate clones, run-index.ts finds the file, the hashes match the
    // freshly checked-out contents, diffState returns changed: [], and their
    // code bucket stays empty run after run with no error at all.
    writeKireoGitignore(dir);
    const text = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(text).toContain('index-state.json');
    expect(text).toContain('.index-state.tmp.*');
    expect(text).toContain('CONTEXT.md');
    // The kill-switch marker is per-machine too.
    expect(text).toContain('disabled');
    // project.json is the ONE thing that must travel with the repo.
    expect(text).not.toMatch(/^project\.json$/m);
  });

  it('never clobbers a .gitignore the user already wrote', () => {
    writeFileSync(join(dir, '.gitignore'), 'mine\n');
    writeKireoGitignore(dir);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('mine\n');
  });
});

describe('kill switch covers EVERY outbound command, enumerated (regression)', () => {
  // `isDisabled` used to be consulted at five hand-written call sites, and the
  // two loudest outbound paths in the CLI were not among them:
  //
  //   - `kireo index` → run-index.ts POSTs every extracted symbol (function
  //     name, signature, file path) to /v1/memories/batch.
  //   - `kireo resume --all` → listHomeCards() reads the cross-project
  //     `kireo-home` bucket straight over the network.
  //
  // Both ran, and uploaded, with KIREO_DISABLED=1 set — while the comment
  // sitting on backfill's own check described that variable as "machine-wide,
  // so nothing may run at all". A user who dropped `.kireo/disabled` into a
  // confidential repo and ran `kireo index .` shipped its whole symbol table.
  //
  // This block, not the two extra call sites, is the fix. It walks
  // KNOWN_COMMANDS instead of a hand-picked list, so the next subcommand
  // someone adds cannot quietly skip the gate: the table below stops
  // typechecking (Record over the exact union) and the coverage case below
  // fails, until it gets an entry.
  const DISABLED_ENV = { KIREO_API_KEY: 'ki_sk_live_abcdef12', KIREO_DISABLED: '1' };
  type GatedCommand = Exclude<(typeof KNOWN_COMMANDS)[number], 'doctor'>;
  const INVOCATIONS: Record<GatedCommand, string[][]> = {
    index: [['index'], ['index', '.']],
    ctx: [['ctx', 'save']],
    project: [
      ['project', 'info'],
      ['project', 'init'],
      ['project', 'init', '--migrate', '--yes'],
      ['project', 'set', 'some-other-key', '--yes'],
      ['project', 'set', 'some-other-key', '--migrate', '--yes'],
      ['project', 'merge', 'ctx-a-111111', 'ctx-b-222222', '--yes'],
    ],
    resume: [['resume'], ['resume', '--all']],
    backfill: [['backfill'], ['backfill', '--dry-run=false']],
  };

  let dir = '';
  let originalCwd = '';
  let originalExitCode: number | string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'kireo-killswitch-')));
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    process.chdir(dir);
    mocks.home.dir = dir;
    mocks.requests.length = 0;
    mocks.clients.n = 0;
    mocks.uploadError.value = null;
    mocks.namespaces.value = [];
    mocks.patchFails.value = [];
    mocks.answer.value = 'y';
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    rmSync(dir, { recursive: true, force: true });
  });

  it('the table covers KNOWN_COMMANDS exactly — doctor excepted, on purpose', () => {
    // doctor is the ONE exemption: it must run WITH the switch on and report
    // that it is on, because "why did nothing happen" is the question it
    // exists to answer. Everything else has to be in the table.
    expect(Object.keys(INVOCATIONS).sort()).toEqual(
      KNOWN_COMMANDS.filter((c) => c !== 'doctor')
        .slice()
        .sort(),
    );
  });

  for (const argvs of Object.values(INVOCATIONS)) {
    for (const argv of argvs) {
      it(`\`kireo ${argv.join(' ')}\` sends nothing and builds no client when disabled`, async () => {
        await runCli({ argv, env: DISABLED_ENV });
        expect(mocks.requests).toHaveLength(0);
        // Before the client, not merely before the request: a gate that fires
        // after construction is one refactor away from firing after the POST.
        expect(mocks.clients.n).toBe(0);
      });
    }
  }

  it('doctor is exempt — it still runs, still reaches the API, and reports the switch', async () => {
    // Not an oversight, the point of the command. If doctor went quiet too,
    // a user whose saves had silently stopped would have no way left to find
    // out that a kill switch was the reason.
    const out = captureStdout();
    await runCli({ argv: ['doctor'], env: DISABLED_ENV });
    out.restore();
    expect(mocks.clients.n).toBe(1);
    expect(mocks.requests.length).toBeGreaterThan(0);
    const text = out.calls.join('');
    expect(text).toContain('隐私开关');
    expect(text).toContain('已开启');
  });

  it('`kireo index` says what it did NOT do, instead of printing a healthy summary', async () => {
    const out = captureStdout();
    await runCli({ argv: ['index', '.'], env: DISABLED_ENV });
    out.restore();
    const text = out.calls.join('');
    expect(text).toContain('隐私开关已启用');
    expect(text).toContain('一个符号都没有上传');
    // The success line must be absent — the old bug printed it after uploading.
    expect(text).not.toContain('-> namespace');
  });

  it('`kireo resume --all` reads no home bucket when disabled', async () => {
    const out = captureStdout();
    await runCli({ argv: ['resume', '--all'], env: DISABLED_ENV });
    out.restore();
    expect(mocks.requests).toHaveLength(0);
    expect(out.calls.join('')).toContain('隐私开关已启用');
  });

  it("obeys the marker in the repo being INDEXED, not just the one you're standing in", async () => {
    // `kireo index ~/secret-repo` run from anywhere else. The bytes about to
    // leave belong to ~/secret-repo, so its `.kireo/disabled` is the one with
    // a vote — the cwd's absence of a marker says nothing about that repo.
    const secret = realpathSync(mkdtempSync(join(tmpdir(), 'kireo-secret-repo-')));
    mkdirSync(join(secret, '.kireo'), { recursive: true });
    writeFileSync(join(secret, '.kireo', 'disabled'), '');
    try {
      const out = captureStdout();
      // env carries NO KIREO_DISABLED, and cwd (a fresh repo) has no marker.
      await runCli({ argv: ['index', secret], env: { KIREO_API_KEY: 'ki_sk_live_abcdef12' } });
      out.restore();
      expect(mocks.requests).toHaveLength(0);
      expect(mocks.clients.n).toBe(0);
      expect(out.calls.join('')).toContain(join(secret, '.kireo', 'disabled'));
    } finally {
      rmSync(secret, { recursive: true, force: true });
    }
  });
});

describe('kireo project set guards AND discloses the ctx bucket (regression)', () => {
  // The previous round disclosed the CODE bucket switch and stopped there.
  // `kireo project set <newkey>` moves the CTX bucket in the same breath — the
  // one `/kireo:resume` actually renders — and that half is unrecoverable:
  // code symbols come back with one `kireo index`, context cards are distilled
  // from sessions that no longer exist. The output named only the code bucket,
  // `--migrate` moved only the code bucket, and so a user who renamed their
  // project key once found resume blank forever with no command to fix it.
  const ENV = { KIREO_API_KEY: 'ki_sk_live_abcdef12' };
  const NEW_KEY = 'renamed-project';
  let dir = '';
  let originalCwd = '';
  let originalExitCode: number | string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    // A real git repo: resolveProjectKey only reads
    // `<repoRoot>/.kireo/project.json`, so outside git the marker is written
    // and then ignored — and no bucket would move at all.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'kireo-ctxbucket-')));
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    process.chdir(dir);
    mocks.home.dir = dir;
    mocks.requests.length = 0;
    mocks.clients.n = 0;
    mocks.uploadError.value = null;
    mocks.namespaces.value = [];
    mocks.patchFails.value = [];
    mocks.answer.value = 'y';
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a silent ctx switch — and writes nothing at all when it refuses', async () => {
    const before = resolveProjectHere(dir);
    const err = captureStderr();
    const out = captureStdout();
    await runCli({ argv: ['project', 'set', NEW_KEY], env: ENV });
    out.restore();
    err.restore();

    const text = err.calls.join('');
    expect(text).toContain('拒绝执行');
    expect(text).toContain(before.ctxNs);
    expect(text).toContain(ctxNamespace(NEW_KEY, sha256Hex));
    // Both escape hatches are named, so refusing is not a dead end.
    expect(text).toContain(`kireo project set ${NEW_KEY} --migrate`);
    expect(text).toContain(`kireo project set ${NEW_KEY} --yes`);
    expect(process.exitCode).toBe(1);
    // "Refused" has to mean the key is untouched, not "half applied".
    expect(existsSync(join(dir, '.kireo', 'project.json'))).toBe(false);
    expect(resolveProjectHere(dir).ctxNs).toBe(before.ctxNs);
  });

  it('`--yes` switches, but names both ctx buckets and hands back a merge command', async () => {
    const before = resolveProjectHere(dir);
    const out = captureStdout();
    await runCli({ argv: ['project', 'set', NEW_KEY, '--yes'], env: ENV });
    out.restore();
    const after = resolveProjectHere(dir);

    expect(after.ctxNs).not.toBe(before.ctxNs);
    const text = out.calls.join('');
    expect(text).toContain('ctx 桶');
    expect(text).toContain(before.ctxNs);
    expect(text).toContain(after.ctxNs);
    expect(text).toContain('不会自动搬过去');
    // The escape hatch is a real command, spelled out with both bucket names.
    expect(text).toContain(`kireo project merge ${before.ctxNs} ${after.ctxNs}`);
    // --yes means "leave them behind", so nothing may have been moved.
    expect(mocks.requests).toHaveLength(0);
  });

  it('`--migrate` moves BOTH buckets, ctx first', async () => {
    const before = resolveProjectHere(dir);
    mocks.namespaces.value = [
      { name: before.ctxNs, count: 4 },
      { name: before.codeNs, count: 9 },
    ];
    const out = captureStdout();
    await runCli({ argv: ['project', 'set', NEW_KEY, '--migrate', '--yes'], env: ENV });
    out.restore();
    const after = resolveProjectHere(dir);

    const patches = mocks.requests.filter((r) => r.method === 'PATCH');
    expect(patches.map((r) => decodeURIComponent(r.path))).toEqual([
      // ctx first: it is the half that cannot be regenerated, so if only one
      // of the two lands it must be that one.
      `/v1/namespaces/${before.ctxNs}`,
      `/v1/namespaces/${before.codeNs}`,
    ]);
    expect(patches.map((r) => (r.body as { name?: string } | undefined)?.name)).toEqual([
      after.ctxNs,
      after.codeNs,
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it('reports a HALF migration instead of letting it pass for a whole one', async () => {
    // Two independent server-side renames, no transaction spanning them, so
    // "ctx moved, code did not" is a state this genuinely ends in. Reporting
    // it as success is what would leave a user believing both buckets moved.
    const before = resolveProjectHere(dir);
    mocks.namespaces.value = [
      { name: before.ctxNs, count: 4 },
      { name: before.codeNs, count: 9 },
    ];
    mocks.patchFails.value = [before.codeNs];
    const out = captureStdout();
    const err = captureStderr();
    await runCli({ argv: ['project', 'set', NEW_KEY, '--migrate', '--yes'], env: ENV });
    err.restore();
    out.restore();
    const after = resolveProjectHere(dir);

    const text = err.calls.join('');
    expect(text).toContain('迁移只完成了一部分');
    expect(text).toContain('已经搬完的：ctx 桶');
    // The command that finishes the job, with the real bucket names in it.
    expect(text).toContain(`kireo project merge ${before.codeNs} ${after.codeNs}`);
    // A half-migration must not read as success to a script.
    expect(process.exitCode).toBe(1);
  });

  it('answering n mid-migration stops, names what did not move, and is not a failure', async () => {
    // The user declining is not the server rejecting. Collapsing both into
    // "exit 1" would cry wolf; collapsing both into "exit 0" would hide a real
    // half-migration. They are reported as different things.
    const before = resolveProjectHere(dir);
    mocks.namespaces.value = [
      { name: before.ctxNs, count: 4 },
      { name: before.codeNs, count: 9 },
    ];
    mocks.answer.value = 'n';
    const out = captureStdout();
    // No --yes: runProjectMerge asks, and the answer above is "n".
    await runCli({ argv: ['project', 'set', NEW_KEY, '--migrate'], env: ENV });
    out.restore();
    const after = resolveProjectHere(dir);

    const text = out.calls.join('');
    expect(text).toContain('已取消：ctx 桶、code 桶没有搬');
    expect(text).toContain(`kireo project merge ${before.ctxNs} ${after.ctxNs}`);
    expect(text).toContain(`kireo project merge ${before.codeNs} ${after.codeNs}`);
    expect(mocks.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('the kill switch aborts `set --migrate` BEFORE the pin, so a rerun still migrates', async () => {
    // Regression from the round that made `--migrate` apply to `set`: the
    // outbound gate sat AFTER project.json was written. With the switch on,
    // `project set <newkey> --migrate` pinned the new key — repointing BOTH
    // buckets — printed "下面就会把它原地改名搬过去", and then aborted the
    // migration without moving anything and without printing a single fixup
    // command. Clearing the switch and rerunning the SAME command was then a
    // no-op: `p.ctxNs` already equalled `after.ctxNs`, `jobs` came out empty,
    // and the run reported "桶名没有变化，不需要迁移。" at exit 0 — while the
    // context cards, which no re-index can regenerate, sat in a bucket whose
    // name never appeared in any output again.
    const before = resolveProjectHere(dir);
    mocks.namespaces.value = [
      { name: before.ctxNs, count: 4 },
      { name: before.codeNs, count: 9 },
    ];

    const out = captureStdout();
    await runCli({
      argv: ['project', 'set', NEW_KEY, '--migrate', '--yes'],
      env: { ...ENV, KIREO_DISABLED: '1' },
    });
    out.restore();

    expect(out.calls.join('')).toContain('隐私开关已启用');
    // Blocked means NOTHING happened: no pin, so no bucket moved on paper
    // either — there is no orphan to go back and rescue.
    expect(existsSync(join(dir, '.kireo', 'project.json'))).toBe(false);
    expect(resolveProjectHere(dir).ctxNs).toBe(before.ctxNs);
    expect(mocks.requests).toHaveLength(0);
    expect(mocks.clients.n).toBe(0);
    // …and it is a failed run, not a quiet success.
    expect(process.exitCode).toBe(1);

    // Clear the switch, rerun the identical command: it has to be one clean
    // full execution, never the "桶名没有变化，不需要迁移。" false success.
    process.exitCode = undefined;
    const out2 = captureStdout();
    await runCli({ argv: ['project', 'set', NEW_KEY, '--migrate', '--yes'], env: ENV });
    out2.restore();
    const after = resolveProjectHere(dir);

    expect(out2.calls.join('')).not.toContain('桶名没有变化，不需要迁移');
    expect(after.ctxNs).toBe(ctxNamespace(NEW_KEY, sha256Hex));
    expect(after.ctxNs).not.toBe(before.ctxNs);
    expect(
      mocks.requests.filter((r) => r.method === 'PATCH').map((r) => decodeURIComponent(r.path)),
    ).toEqual([`/v1/namespaces/${before.ctxNs}`, `/v1/namespaces/${before.codeNs}`]);
    expect(process.exitCode).toBeUndefined();
  });

  it('`project init --migrate` does not tell you to run the flag you just ran', async () => {
    const before = resolveProjectHere(dir);
    mocks.namespaces.value = [{ name: before.codeNs, count: 9 }];
    const out = captureStdout();
    await runCli({ argv: ['project', 'init', '--migrate', '--yes'], env: ENV });
    out.restore();
    const text = out.calls.join('');
    // init pins the key it already resolved, so the ctx bucket cannot move —
    // only the code bucket does, and the migration for it runs right below.
    expect(text).not.toContain('要搬：`kireo project init --migrate`');
    expect(text).toContain('下面就会把它原地改名搬过去');
    expect(text).toContain(before.codeNs);
  });
});
