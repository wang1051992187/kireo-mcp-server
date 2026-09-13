import { MEMORY_LIMITS } from '@kireo/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  type BackfillFsDeps,
  type BackfillItem,
  type SessionPrivacyVerdict,
  backfillBody,
  discoverSessions,
  groupByProject,
  runBackfill,
  slugifyCwd,
} from '../../src/context/backfill.js';

const HOME = '/home/u';

const CLAUDE_TURN = (role: 'user' | 'assistant', text: string) =>
  JSON.stringify({ type: role, message: { role, content: text } });

const normalClaudeJsonl = [
  CLAUDE_TURN('user', 'help me fix the SSE reconnect bug'),
  CLAUDE_TURN('assistant', 'looked at the retry backoff, it doubles instead of resetting'),
].join('\n');

const badFormatJsonl = ['{"type":"some_future_shape","payload":{"foo":"bar"}}'].join('\n');

const codexRollout = (cwd: string) =>
  [
    JSON.stringify({ type: 'session_meta', payload: { cwd } }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'item',
        item: { type: 'UserMessage', content: [{ type: 'text', text: 'hi' }] },
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'item',
        item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'hello back' }] },
      },
    }),
  ].join('\n');

/**
 * A tiny in-memory filesystem keyed by absolute path. Register files with
 * their content + mtime; directories are inferred from the file paths so
 * `readDir`/`stat` behave like the real thing without ever touching disk.
 */
function makeFakeFs(files: Record<string, { content: string; mtimeMs: number }>): BackfillFsDeps {
  const dirs = new Set<string>();
  for (const path of Object.keys(files)) {
    let p = path;
    while (true) {
      const idx = p.lastIndexOf('/');
      if (idx <= 0) break;
      p = p.slice(0, idx);
      dirs.add(p);
    }
  }
  const readDir = async (dir: string): Promise<string[]> => {
    const prefix = `${dir}/`;
    const names = new Set<string>();
    for (const path of [...Object.keys(files), ...dirs]) {
      if (path.startsWith(prefix) && path !== dir) {
        names.add(path.slice(prefix.length).split('/')[0] ?? '');
      }
    }
    if (names.size === 0 && !dirs.has(dir) && !(dir in files)) {
      throw new Error(`ENOENT: ${dir}`);
    }
    return [...names].filter(Boolean);
  };
  const stat = async (path: string) => {
    if (path in files) {
      const f = files[path];
      if (!f) throw new Error(`ENOENT: ${path}`);
      return { isDirectory: () => false, mtimeMs: f.mtimeMs };
    }
    if (dirs.has(path)) return { isDirectory: () => true, mtimeMs: 0 };
    throw new Error(`ENOENT: ${path}`);
  };
  const readFile = async (path: string): Promise<string> => {
    const f = files[path];
    if (!f) throw new Error(`ENOENT: ${path}`);
    return f.content;
  };
  return { readDir, readFile, stat };
}

describe('discoverSessions', () => {
  it('only collects sessions inside the --since window', async () => {
    const fs = makeFakeFs({
      [`${HOME}/.claude/projects/-home-u-proj/recent.jsonl`]: {
        content: normalClaudeJsonl,
        mtimeMs: Date.parse('2026-08-25T00:00:00.000Z'),
      },
      [`${HOME}/.claude/projects/-home-u-proj/old.jsonl`]: {
        content: normalClaudeJsonl,
        mtimeMs: Date.parse('2026-01-01T00:00:00.000Z'),
      },
    });
    const out = await discoverSessions({
      since: new Date('2026-08-01T00:00:00.000Z'),
      homeDir: HOME,
      ...fs,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.path).toContain('recent.jsonl');
  });

  it('assigns Claude sessions their directory cwd-slug, and Codex sessions the rollout cwd', async () => {
    const fs = makeFakeFs({
      [`${HOME}/.claude/projects/-home-u-kireo/s1.jsonl`]: {
        content: normalClaudeJsonl,
        mtimeMs: Date.parse('2026-08-29T00:00:00.000Z'),
      },
      [`${HOME}/.codex/sessions/2026/08/28/rollout-1.jsonl`]: {
        content: codexRollout('/home/u/ratfish-web'),
        mtimeMs: Date.parse('2026-08-28T00:00:00.000Z'),
      },
    });
    const out = await discoverSessions({
      since: new Date('2026-01-01T00:00:00.000Z'),
      homeDir: HOME,
      ...fs,
    });
    const claude = out.find((s) => s.host === 'claude-code');
    const codex = out.find((s) => s.host === 'codex');
    expect(claude?.cwdSlug).toBe('-home-u-kireo');
    expect(codex?.cwdSlug).toBe('-home-u-ratfish-web');

    const grouped = groupByProject(out);
    expect(grouped.size).toBe(2);
    expect(grouped.get('-home-u-kireo')).toHaveLength(1);
    expect(grouped.get('-home-u-ratfish-web')).toHaveLength(1);
  });

  it('returns [] for a home directory with neither .claude nor .codex, without throwing', async () => {
    const fs = makeFakeFs({});
    await expect(discoverSessions({ since: new Date(0), homeDir: HOME, ...fs })).resolves.toEqual(
      [],
    );
  });
});

/** Explicit "this project is not disabled" for cases that are not about privacy. */
const allowAll = (): SessionPrivacyVerdict => 'allow';

describe('cwd-slug lossiness (why the privacy gate never reverses one)', () => {
  it('maps different directories onto the SAME slug', () => {
    // cli.ts's `projectDirOf` refuses to guess a directory from a slug, and
    // this is why: the reversal is not unique. A '-' inside a real directory
    // name is indistinguishable from a path separator…
    expect(slugifyCwd('/Users/me/my-app')).toBe(slugifyCwd('/Users/me/my/app'));
    // …and a CJK path collapses to something whose only plausible reversal
    // (`/Users/me/`) is a directory that exists and is the wrong one. Reading
    // THAT directory's .kireo/disabled and calling it an answer would be worse
    // than the bug being fixed.
    expect(slugifyCwd('/Users/me/项目')).toBe('-Users-me-');
  });
});

describe('runBackfill privacy gate', () => {
  const twoSessions = () =>
    makeFakeFs({
      [`${HOME}/.claude/projects/-home-u-secret/a.jsonl`]: {
        content: normalClaudeJsonl,
        mtimeMs: Date.parse('2026-08-29T00:00:00.000Z'),
      },
      [`${HOME}/.claude/projects/-home-u-open/b.jsonl`]: {
        content: normalClaudeJsonl,
        mtimeMs: Date.parse('2026-08-29T00:00:00.000Z'),
      },
    });

  it('skips a disabled project without touching the rest of the run', async () => {
    const post = vi.fn(async (_item: BackfillItem) => undefined);
    const previewed: string[] = [];
    const out = await runBackfill({
      since: new Date('2026-01-01T00:00:00.000Z'),
      homeDir: HOME,
      ...twoSessions(),
      dryRun: false,
      post,
      onParsed: (item) => previewed.push(item.path),
      privacyGate: (item) => (item.cwdSlug === '-home-u-secret' ? 'disabled' : 'allow'),
    });

    // The disabled project's session was neither uploaded NOR previewed — the
    // preview text is printed to the user's terminal verbatim, so a repo that
    // said "send nothing" must not be dumped there either.
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]?.cwdSlug).toBe('-home-u-open');
    expect(previewed).toEqual([`${HOME}/.claude/projects/-home-u-open/b.jsonl`]);

    // Reported honestly, and counted exactly once.
    expect(out.privacySkipped).toBe(1);
    expect(out.unresolvedSkipped).toBe(0);
    expect(out.processed).toBe(1);
    expect(out.skipped).toBe(1);
    expect(out.processed + out.skipped).toBe(2);
    // Not an error: the run did what the user asked, minus what they forbade.
    expect(out.errors).toEqual([]);
    expect(out.uploadFailed).toBe(0);
  });

  it('counts an unidentifiable project separately, and still skips it', async () => {
    const post = vi.fn(async (_item: BackfillItem) => undefined);
    const out = await runBackfill({
      since: new Date('2026-01-01T00:00:00.000Z'),
      homeDir: HOME,
      ...twoSessions(),
      dryRun: false,
      post,
      privacyGate: (item) => (item.cwdSlug === '-home-u-secret' ? 'unresolved' : 'allow'),
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(out.unresolvedSkipped).toBe(1);
    expect(out.privacySkipped).toBe(0);
    expect(out.skipped).toBe(1);
  });

  it('gates the DRY RUN too — a preview is still a disclosure', async () => {
    const previewed: string[] = [];
    const out = await runBackfill({
      since: new Date('2026-01-01T00:00:00.000Z'),
      homeDir: HOME,
      ...twoSessions(),
      dryRun: true,
      post: vi.fn(),
      onParsed: (item) => previewed.push(item.path),
      privacyGate: () => 'disabled',
    });
    expect(previewed).toEqual([]);
    expect(out.processed).toBe(0);
    expect(out.privacySkipped).toBe(2);
  });
});

describe('runBackfill', () => {
  it('keeps going when ONE session fails to parse', async () => {
    // A single host-format oddity must not abort a 90-day backfill.
    const fs = makeFakeFs({
      [`${HOME}/.claude/projects/-home-u-proj/good.jsonl`]: {
        content: normalClaudeJsonl,
        mtimeMs: Date.parse('2026-08-29T00:00:00.000Z'),
      },
      [`${HOME}/.claude/projects/-home-u-proj/bad.jsonl`]: {
        content: badFormatJsonl,
        mtimeMs: Date.parse('2026-08-29T00:00:00.000Z'),
      },
    });
    const post = vi.fn();
    const out = await runBackfill({
      // The gate is REQUIRED (see RunBackfillOpts): these cases are about the
      // parse/upload machinery, so they opt in explicitly rather than relying
      // on a permissive default that could hide a missing kill switch.
      privacyGate: allowAll,
      since: new Date('2026-01-01T00:00:00.000Z'),
      homeDir: HOME,
      ...fs,
      dryRun: false,
      post,
    });
    expect(out.processed).toBe(1);
    expect(out.skipped).toBe(1);
    expect(out.errors[0]).toMatch(/格式|format/i);
    // Naming the file and the stage is the difference between an actionable
    // report and 47 anonymous error strings.
    expect(out.errors[0]).toContain('bad.jsonl');
    expect(out.errors[0]).toContain('解析');
    expect(out.uploadFailed).toBe(0);
    // The good session still got uploaded despite the bad one existing.
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('keeps going when ONE session fails to UPLOAD, and never throws', async () => {
    // The parse stage was already contained; the upload stage was not. A single
    // 429/503 in the middle of a 47-session backfill used to throw out of
    // runBackfill, through cli.ts, into bin/kireo.cjs's `[kireo] fatal:` catch —
    // destroying the summary of everything that had already succeeded.
    const fs = makeFakeFs({
      [`${HOME}/.claude/projects/-home-u-proj/a.jsonl`]: {
        content: normalClaudeJsonl,
        mtimeMs: Date.parse('2026-08-29T00:00:00.000Z'),
      },
      [`${HOME}/.claude/projects/-home-u-proj/boom.jsonl`]: {
        content: normalClaudeJsonl,
        mtimeMs: Date.parse('2026-08-29T00:00:00.000Z'),
      },
      [`${HOME}/.claude/projects/-home-u-proj/c.jsonl`]: {
        content: normalClaudeJsonl,
        mtimeMs: Date.parse('2026-08-29T00:00:00.000Z'),
      },
    });
    const uploaded: string[] = [];
    const post = vi.fn(async (item: BackfillItem) => {
      if (item.path.endsWith('boom.jsonl')) throw new Error('429 Too Many Requests');
      uploaded.push(item.path);
    });

    const out = await runBackfill({
      // The gate is REQUIRED (see RunBackfillOpts): these cases are about the
      // parse/upload machinery, so they opt in explicitly rather than relying
      // on a permissive default that could hide a missing kill switch.
      privacyGate: allowAll,
      since: new Date('2026-01-01T00:00:00.000Z'),
      homeDir: HOME,
      ...fs,
      dryRun: false,
      post,
    });

    // Every session was attempted; the two healthy ones actually landed.
    expect(post).toHaveBeenCalledTimes(3);
    expect(uploaded).toHaveLength(2);
    expect(uploaded.some((p) => p.endsWith('a.jsonl'))).toBe(true);
    expect(uploaded.some((p) => p.endsWith('c.jsonl'))).toBe(true);
    // A failed upload is counted ONCE, as skipped — never also as processed.
    expect(out.processed).toBe(2);
    expect(out.skipped).toBe(1);
    expect(out.uploadFailed).toBe(1);
    expect(out.processed + out.skipped).toBe(3);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain('boom.jsonl');
    expect(out.errors[0]).toContain('上传');
    expect(out.errors[0]).toContain('429');
  });

  it('separates upload failures from parse failures in the same run', async () => {
    const fs = makeFakeFs({
      [`${HOME}/.claude/projects/-home-u-proj/good.jsonl`]: {
        content: normalClaudeJsonl,
        mtimeMs: Date.parse('2026-08-29T00:00:00.000Z'),
      },
      [`${HOME}/.claude/projects/-home-u-proj/bad.jsonl`]: {
        content: badFormatJsonl,
        mtimeMs: Date.parse('2026-08-29T00:00:00.000Z'),
      },
      [`${HOME}/.claude/projects/-home-u-proj/boom.jsonl`]: {
        content: normalClaudeJsonl,
        mtimeMs: Date.parse('2026-08-29T00:00:00.000Z'),
      },
    });
    const post = vi.fn(async (item: BackfillItem) => {
      if (item.path.endsWith('boom.jsonl')) throw new Error('503 Service Unavailable');
    });

    const out = await runBackfill({
      // The gate is REQUIRED (see RunBackfillOpts): these cases are about the
      // parse/upload machinery, so they opt in explicitly rather than relying
      // on a permissive default that could hide a missing kill switch.
      privacyGate: allowAll,
      since: new Date('2026-01-01T00:00:00.000Z'),
      homeDir: HOME,
      ...fs,
      dryRun: false,
      post,
    });

    expect(out.processed).toBe(1);
    expect(out.skipped).toBe(2);
    // cli.ts leans on this split: an unreadable file is exit 0, a rejected
    // upload is exit 1.
    expect(out.uploadFailed).toBe(1);
    expect(out.errors).toHaveLength(2);
  });

  it('never reports an upload failure under dry-run (nothing is uploaded)', async () => {
    const fs = makeFakeFs({
      [`${HOME}/.claude/projects/-home-u-proj/good.jsonl`]: {
        content: normalClaudeJsonl,
        mtimeMs: Date.parse('2026-08-29T00:00:00.000Z'),
      },
    });
    const post = vi.fn(async () => {
      throw new Error('should never be called under dry-run');
    });
    const out = await runBackfill({
      // The gate is REQUIRED (see RunBackfillOpts): these cases are about the
      // parse/upload machinery, so they opt in explicitly rather than relying
      // on a permissive default that could hide a missing kill switch.
      privacyGate: allowAll,
      since: new Date('2026-01-01T00:00:00.000Z'),
      homeDir: HOME,
      ...fs,
      dryRun: true,
      post,
    });
    expect(post).not.toHaveBeenCalled();
    expect(out.processed).toBe(1);
    expect(out.uploadFailed).toBe(0);
    expect(out.errors).toEqual([]);
  });

  it('defaults to dry-run', async () => {
    const fs = makeFakeFs({
      [`${HOME}/.claude/projects/-home-u-proj/good.jsonl`]: {
        content: normalClaudeJsonl,
        mtimeMs: Date.parse('2026-08-29T00:00:00.000Z'),
      },
    });
    const post = vi.fn();
    const out = await runBackfill({
      // The gate is REQUIRED (see RunBackfillOpts): these cases are about the
      // parse/upload machinery, so they opt in explicitly rather than relying
      // on a permissive default that could hide a missing kill switch.
      privacyGate: allowAll,
      since: new Date('2026-01-01T00:00:00.000Z'),
      homeDir: HOME,
      ...fs,
      // dryRun omitted on purpose.
      post,
    });
    expect(post).not.toHaveBeenCalled();
    expect(out.processed).toBe(1);
  });

  it('an explicit dryRun: false uploads every cleanly-parsed session', async () => {
    const fs = makeFakeFs({
      [`${HOME}/.claude/projects/-home-u-proj/good.jsonl`]: {
        content: normalClaudeJsonl,
        mtimeMs: Date.parse('2026-08-29T00:00:00.000Z'),
      },
    });
    const post = vi.fn(async (_item: BackfillItem) => undefined);
    await runBackfill({
      // The gate is REQUIRED (see RunBackfillOpts): these cases are about the
      // parse/upload machinery, so they opt in explicitly rather than relying
      // on a permissive default that could hide a missing kill switch.
      privacyGate: allowAll,
      since: new Date('2026-01-01T00:00:00.000Z'),
      homeDir: HOME,
      ...fs,
      dryRun: false,
      post,
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toMatchObject({ host: 'claude-code', cwdSlug: '-home-u-proj' });
  });
});

describe('backfillBody', () => {
  const item = (text: string): BackfillItem => ({
    host: 'claude-code',
    path: `${HOME}/.claude/projects/-home-u-proj/s.jsonl`,
    cwdSlug: '-home-u-proj',
    cwd: '/home/u/proj',
    turns: [{ role: 'user', text }],
  });

  it('redacts known credential shapes — this output is what gets PRINTED as well as sent', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
    const out = backfillBody(item(`token is ${secret} ok`));
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  it('truncates to CONTENT_MAX, so the preview cannot promise more than the API stores', () => {
    const out = backfillBody(item('x'.repeat(MEMORY_LIMITS.CONTENT_MAX * 2)));
    expect(out).toHaveLength(MEMORY_LIMITS.CONTENT_MAX);
  });

  it('is a pure function of the item — same item, byte-identical output', () => {
    const i = item('hello');
    expect(backfillBody(i)).toBe(backfillBody(i));
    expect(backfillBody(i)).toBe('[user] hello');
  });
});
