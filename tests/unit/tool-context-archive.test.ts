import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_LIMITS } from '@kireo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveChunks, archiveProject } from '../../src/context/archive.js';
import { listOutbox } from '../../src/context/outbox.js';
import { contextArchiveTool } from '../../src/tools/context-archive.js';
import type { ToolContext } from '../../src/tools/shared.js';

interface Item {
  content: string;
  namespace: string;
  metadata: {
    file_path: string;
    filename: string;
    snapshot_id: string;
    chunk_index: number;
    chunk_count: number;
  };
}
interface Request {
  method: string;
  path: string;
  body: { items: Item[] };
}
const ack = (request: Request) => ({
  succeeded: request.body.items.map((_, index) => ({ index, id: `m${index}` })),
  failures: [],
});
const resultOf = (result: Awaited<ReturnType<typeof contextArchiveTool.handler>>) => {
  const text = (result.content[0] as { text: string }).text;
  return JSON.parse(text.slice(text.indexOf('```json\n') + 8, text.lastIndexOf('\n```')));
};
const context = (request: unknown): ToolContext => ({
  rest: { request } as ToolContext['rest'],
  logger: { warn: vi.fn() } as unknown as ToolContext['logger'],
});
let base: string;
let cwd: string;
const input = (overrides: Record<string, unknown> = {}) => ({
  cwd,
  summary: '# 项目记忆\n\n决定保留本地副本；部署尚未获得确认，下一步测试断网补传。',
  host: 'codex' as const,
  session_id: 'session-1',
  dry_run: false,
  ...overrides,
});

beforeEach(() => {
  vi.stubEnv('KIREO_DISABLED', '');
  base = realpathSync(mkdtempSync(join(tmpdir(), 'kireo-archive-')));
  cwd = join(base, '记忆项目');
  mkdirSync(cwd);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

describe('directory conversation archive', () => {
  it('previews the exact redacted payload without disk or HTTP side effects', async () => {
    const request = vi.fn();
    const secret = `ghp_${'x'.repeat(30)}`;
    const result = resultOf(
      await contextArchiveTool.handler(
        input({ dry_run: true, summary: `不要保存密钥 ${secret}` }),
        context(request),
      ),
    );
    expect(result.dry_run).toBe(true);
    expect(result.filename).toBe('记忆项目.md');
    expect(result.items[0].content).toContain('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(request).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, '.kireo'))).toBe(false);
  });

  it('writes the same-named Markdown and retry record BEFORE sending, with no absolute path upstream', async () => {
    const p = archiveProject(cwd);
    const request = vi.fn(async (req: Request) => {
      const pending = listOutbox(join(p.archiveDir, 'outbox'));
      expect(pending).toHaveLength(1);
      const item = req.body.items[0];
      if (!item) throw new Error('missing uploaded item');
      expect(readFileSync(join(p.archiveDir, item.metadata.snapshot_id, p.filename), 'utf8')).toBe(
        input().summary,
      );
      expect(item.metadata.file_path).toBe('记忆项目.md');
      expect(item.namespace).toBe(p.namespace);
      expect(JSON.stringify(req)).not.toContain(base);
      return ack(req);
    });
    const result = resultOf(await contextArchiveTool.handler(input(), context(request)));
    expect(result).toMatchObject({ stored: 1, outbox_pending: false, memory_ids: ['m0'] });
    expect(listOutbox(join(p.archiveDir, 'outbox'))).toHaveLength(0);
    expect(readFileSync(join(p.archiveDir, '.gitignore'), 'utf8')).toContain('*');
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', path: '/v1/memories/batch' }),
    );
  });

  it('splits long Unicode summaries losslessly into API-sized versioned parts', async () => {
    const summary = `${'中'.repeat(7839)}😀\n${'后续步骤\n'.repeat(2000)}`;
    const request = vi.fn(async (req: Request) => ack(req));
    const result = resultOf(await contextArchiveTool.handler(input({ summary }), context(request)));
    const items = request.mock.calls[0]?.[0].body.items;
    if (!items) throw new Error('missing upload request');
    expect(items.length).toBeGreaterThan(1);
    expect(
      items
        .map((item) => item.content.replace(/\n\n<!-- kireo-archive [\s\S]*? -->$/, ''))
        .join(''),
    ).toBe(summary.trim());
    for (const [index, item] of items.entries()) {
      expect(item.content.length).toBeLessThanOrEqual(MEMORY_LIMITS.CONTENT_MAX);
      expect(Buffer.from(item.content).toString('utf8')).toBe(item.content);
      expect(item.metadata).toMatchObject({
        chunk_index: index,
        chunk_count: items.length,
        filename: '记忆项目.md',
      });
      expect(Buffer.byteLength(JSON.stringify(item.metadata))).toBeLessThanOrEqual(
        MEMORY_LIMITS.METADATA_BYTES_MAX,
      );
    }
    expect(readFileSync(result.local_path, 'utf8')).toBe(summary.trim());
    expect(archiveChunks(`${'a'.repeat(7999)}😀`).join('')).toBe(`${'a'.repeat(7999)}😀`);
  });

  it.each([
    { succeeded: [], failures: [] },
    { succeeded: [{ index: 1, id: 'wrong-index' }], failures: [] },
    { succeeded: [{ index: 0, id: 'm0' }] },
    { succeeded: [], failures: [{ index: 0, code: 'QUOTA_EXCEEDED' }] },
  ])('keeps an incomplete or malformed acknowledgement queued: %j', async (response) => {
    const request = vi.fn(async () => response);
    const result = resultOf(await contextArchiveTool.handler(input(), context(request)));
    expect(result.outbox_pending).toBe(true);
    expect(result.stored).toBe(0);
    expect(listOutbox(join(archiveProject(cwd).archiveDir, 'outbox'))).toHaveLength(1);
    // The replay path must obey the same rule as the initial upload.
    const again = resultOf(await contextArchiveTool.handler(input(), context(request)));
    expect(again.previous_pending).toBe(1);
  });

  it('retries an offline save on the next invocation and preserves both local versions', async () => {
    const request = vi.fn(async (_req: Request) => {
      throw new Error('offline');
    });
    const first = resultOf(await contextArchiveTool.handler(input(), context(request)));
    expect(first.outbox_pending).toBe(true);
    const recovered = vi.fn(async (req: Request) => ack(req));
    const second = resultOf(
      await contextArchiveTool.handler(
        input({ summary: '约束保持不变，断网测试已通过。' }),
        context(recovered),
      ),
    );
    expect(second).toMatchObject({
      outbox_pending: false,
      retried_entries: 1,
      previous_pending: 0,
    });
    expect(recovered).toHaveBeenCalledTimes(2);
    expect(listOutbox(join(archiveProject(cwd).archiveDir, 'outbox'))).toHaveLength(0);
    expect(readFileSync(first.local_path, 'utf8')).toBe(input().summary);
    expect(readFileSync(second.local_path, 'utf8')).toContain('已通过');
  });

  it('reuses deterministic payloads for retry dedup and distinguishes shared paragraphs across versions', async () => {
    const request = vi.fn(async (req: Request) => ({
      succeeded: req.body.items.map((_, index) => ({ index, id: `m${index}`, deduped: true })),
      failures: [],
    }));
    const summary = 'x'.repeat(8000);
    await contextArchiveTool.handler(input({ summary }), context(request));
    const second = resultOf(await contextArchiveTool.handler(input({ summary }), context(request)));
    expect(second).toMatchObject({ stored: 0, deduped: 2, outbox_pending: false });
    expect(request.mock.calls[0]?.[0].body).toEqual(request.mock.calls[1]?.[0].body);
    await contextArchiveTool.handler(input({ summary: `${summary}new` }), context(request));
    expect(request.mock.calls[2]?.[0].body.items[0]?.content).not.toBe(
      request.mock.calls[0]?.[0].body.items[0]?.content,
    );
  });

  it('distinguishes same-named folders and subdirectories while resolving symlinks consistently', () => {
    const second = join(base, 'other', '记忆项目');
    mkdirSync(second, { recursive: true });
    const link = join(base, 'alias');
    symlinkSync(cwd, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(archiveProject(cwd).namespace).not.toBe(archiveProject(second).namespace);
    expect(archiveProject(cwd)).toEqual(archiveProject(link));
    expect(() => archiveProject('.')).toThrow('absolute');
  });

  it('honors both directory and enclosing repository kill switches, before even validating the summary', async () => {
    execFileSync('git', ['init', '-q', base]);
    const request = vi.fn();
    for (const directory of [base, cwd]) {
      mkdirSync(join(directory, '.kireo'), { recursive: true });
      writeFileSync(join(directory, '.kireo', 'disabled'), '');
      const result = resultOf(
        await contextArchiveTool.handler(input({ summary: '' }), context(request)),
      );
      expect(result.disabled).toBe(true);
      rmSync(join(directory, '.kireo', 'disabled'));
    }
    vi.stubEnv('KIREO_DISABLED', '1');
    expect(resultOf(await contextArchiveTool.handler(input(), context(request))).disabled).toBe(
      true,
    );
    expect(request).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, '.kireo', 'archives'))).toBe(false);
  });

  it('rejects empty and oversized input before disk writes or upload', async () => {
    const request = vi.fn();
    for (const summary of ['', ' ', 'x'.repeat(64_001)]) {
      await expect(
        contextArchiveTool.handler(input({ summary }), context(request)),
      ).rejects.toThrow();
    }
    expect(request).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, '.kireo'))).toBe(false);
  });
});
