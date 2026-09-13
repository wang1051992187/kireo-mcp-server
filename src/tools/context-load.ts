import { CONTEXT_BUCKETS, type ContextBucket, MEMORY_LIMITS } from '@kireo/shared';
import { z } from 'zod';
import { writeContextMd } from '../context/context-md.js';
import { listItems } from '../context/list-envelope.js';
import { flushOutbox } from '../context/outbox-flush.js';
import { listOutbox } from '../context/outbox.js';
import { repoRootOrCwd, resolveProjectHere } from '../context/project.js';
import { isDisabled } from '../context/redact.js';
import { type RenderableEntry, renderContext } from '../context/render.js';
import { INDEX_HEAD_TAG, readIndexHead } from '../index/index-head.js';
import { type ToolContext, defineTool, toTextResult } from './shared.js';

/**
 * Pages of `PAGE_LIMIT` rows this will pull before giving up and saying so.
 *
 * One page used to be the whole story: `limit = min(200, LIST_LIMIT_MAX)` with
 * the returned `next_cursor` thrown away. The list is ordered occurred_at
 * DESC, so past ~200 saved rows the OLDEST entries became permanently
 * invisible — including `constraint` and `open`, the two buckets
 * context-schema.ts deliberately gives a null half-life ("a constraint does not
 * become less true by getting old"). The write side promised no decay while
 * the read side hard-cut by time.
 *
 * Bounded rather than unbounded because each page is a read against a plan
 * quota (free = 200 reads/month); 5 pages covers a project with ~1000 stored
 * entries, and anything past that is reported in the header instead of being
 * silently dropped.
 */
const MAX_PAGES = 5;

const Input = z
  .object({
    cwd: z.string().optional(),
    outbox_dir: z.string().optional(),
    audit_log_path: z.string().optional(),
    token_budget: z.number().int().min(200).max(4000).default(1200),
  })
  .strict();

const defaultOutboxDir = (): string => `${process.env.HOME ?? '.'}/.kireo/outbox`;

/** Tag `kireo backfill` puts on raw imported session text. */
const BACKFILL_TAG = 'k-backfill';

type InputT = z.infer<typeof Input>;

interface ListResponse {
  items: ListedMemory[];
  next_cursor: string | null;
}

interface ListedMemory {
  id: string;
  content: string;
  type: string;
  tags?: string[];
  importance?: number;
  occurred_at: string;
  metadata?: Record<string, unknown>;
}

const bucketOf = (m: ListedMemory): ContextBucket => {
  const fromMeta = m.metadata?.bucket;
  if (typeof fromMeta === 'string' && (CONTEXT_BUCKETS as readonly string[]).includes(fromMeta)) {
    return fromMeta as ContextBucket;
  }
  // Metadata may be absent (include_metadata off, or an older card): the
  // k-<bucket> tag carries the same information.
  for (const t of m.tags ?? []) {
    const b = t.startsWith('k-') ? t.slice(2) : '';
    if ((CONTEXT_BUCKETS as readonly string[]).includes(b)) return b as ContextBucket;
  }
  return 'map';
};

export const contextLoadTool = defineTool<InputT>({
  name: 'context_load',
  description: [
    'Load previously saved context for the current project and render it.',
    '',
    'When to use: at the start of work on a project — especially on a machine',
    'or in a tool where you have not worked on it before.',
    '',
    'The first line reports the project identity and the code index freshness.',
    'Relay both to the user; never assume the code index is current.',
    '',
    'Returns rendered text, grouped constraints → open threads → decisions →',
    'gotchas → key files → preferences.',
    '',
    'A repo with a `.kireo/disabled` file, or the KIREO_DISABLED env var,',
    'disables this tool entirely — it returns immediately and does nothing: no',
    'outbox flush, no request, no CONTEXT.md.',
  ].join('\n'),
  schema: Input,
  handler: async (input, ctx: ToolContext) => {
    // Kill switch FIRST — before the outbox flush, before any request, before
    // CONTEXT.md. Same rule and same wording as context_save
    // (context-save.ts's handler): a hit means "return immediately and do
    // nothing at all", and writing a file counts as doing something.
    //
    // This tool became an outbound path the day `flushOutbox` was hoisted to
    // the top of it (to fix "the outbox is write-only"), and that hoist landed
    // with no kill-switch check: a user who put `.kireo/disabled` in a
    // confidential repo still shipped every queued context card the next time
    // anything ran `/kireo:resume` or `kireo resume`. The switch's whole
    // reason to exist is that nothing leaves such a repo, so it has to be
    // checked on EVERY path that can talk to the API, not just on the one
    // that writes.
    const cwdRaw = (input as { cwd?: unknown } | undefined)?.cwd;
    const cwd = typeof cwdRaw === 'string' ? cwdRaw : process.cwd();
    if (isDisabled(repoRootOrCwd(cwd), process.env)) {
      ctx.logger.info({ cwd }, 'tool.context_load.disabled');
      return toTextResult(
        'kireo 隐私开关已启用（.kireo/disabled 或 KIREO_DISABLED），本次未做任何操作：\n' +
          '没有联网取回上下文，没有补传本地积压的 outbox，也没有写 .kireo/CONTEXT.md。\n' +
          '要恢复，删掉仓库里的 .kireo/disabled，或取消 KIREO_DISABLED 环境变量。',
      );
    }

    const p = resolveProjectHere(cwd);
    const limit = Math.min(200, MEMORY_LIMITS.LIST_LIMIT_MAX);

    // Flush first: the outbox exists so an upload failure never loses a save,
    // and "next save or resume retries it" is what this tool's own banner (and
    // spec §11, and doctor's hint) promises the user. Best-effort — a resume
    // must still render when the API is unreachable.
    let flushedEntries = 0;
    try {
      const flushed = await flushOutbox(ctx.rest, input.outbox_dir ?? defaultOutboxDir(), {
        ...(input.audit_log_path ? { auditLogPath: input.audit_log_path } : {}),
        onError: (err) => ctx.logger.warn({ err }, 'tool.context_load.outbox_flush_failed'),
      });
      flushedEntries = flushed.entries;
    } catch (err) {
      ctx.logger.warn({ err }, 'tool.context_load.outbox_flush_failed');
    }

    // The list array is `items`, NOT `data`: GET /v1/memories returns
    // `{ items, next_cursor }` (apps/api/src/memory/service.ts#ListResult,
    // returned verbatim by routes/memories.ts). Dereferencing `data` threw a
    // bare TypeError on every real response — the retrieval half of the whole
    // feature was dead against the actual API, and invisible because every
    // unit test and both hand-written fake servers copied the wrong key.
    const rows: ListedMemory[] = [];
    let cursor: string | null = null;
    let moreBeyondFetched = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const path = `/v1/memories?namespace=${encodeURIComponent(p.ctxNs)}&limit=${limit}${cursorParam}`;
      const res: ListResponse = await ctx.rest.request<ListResponse>({ method: 'GET', path });
      rows.push(...listItems<ListedMemory>(res, path));
      cursor = res.next_cursor ?? null;
      if (!cursor) break;
      if (page === MAX_PAGES - 1) moreBeyondFetched = true;
    }

    // Two kinds of row share this namespace without being saved context:
    //
    //  - the commit-anchor card (it's metadata about the index, and the code
    //    bucket is the wrong home for it — see index-head.ts);
    //  - `kireo backfill`'s raw session dumps (`k-backfill`), which are whole
    //    transcripts up to CONTENT_MAX = 8000 chars rather than distilled
    //    entries. `bucketOf` would file one as 'map', and a single 8000-char
    //    bullet is more than six times the default token budget — the render
    //    loop stops at the first entry that doesn't fit, so one backfill card
    //    could truncate an entire resume down to its header. They stay
    //    searchable in this bucket (memory_search, the dashboard); they are
    //    just not resume material.
    //
    // Neither may surface as a bogus bullet in the render below.
    const entries: RenderableEntry[] = rows
      .filter((m) => {
        const tags = m.tags ?? [];
        return !tags.includes(INDEX_HEAD_TAG) && !tags.includes(BACKFILL_TAG);
      })
      .map((m) => ({
        id: m.id,
        bucket: bucketOf(m),
        content: m.content,
        occurredAt: m.occurred_at,
        importance: typeof m.importance === 'number' ? m.importance : 0.5,
        host: typeof m.metadata?.host === 'string' ? m.metadata.host : 'unknown',
        uncertain: m.metadata?.uncertain === true,
      }));

    const now = new Date();
    const head = await readIndexHead(ctx.rest, p.ctxNs, {
      codeNs: p.codeNs,
      indexRoot: p.indexRoot,
    });
    const headTs = head ? Date.parse(head.ts) : Number.NaN;
    const indexAgeDays =
      head && !Number.isNaN(headTs) ? Math.max(0, (now.getTime() - headTs) / 86_400_000) : null;

    const body = renderContext(
      entries,
      {
        projectKey: p.key,
        source: p.source,
        indexCommit: head?.commit ?? null,
        indexAgeDays,
        moreBeyondFetched,
      },
      now,
      input.token_budget,
    );

    let pending = 0;
    try {
      pending = listOutbox(input.outbox_dir ?? defaultOutboxDir()).length;
    } catch {
      // A missing or unreadable outbox must never block a read.
    }

    try {
      // Normalize to the git repo root (same convention as context-save.ts's
      // kill-switch check and `kireo project init/set`) — cwd may be a
      // subdirectory, and CONTEXT.md must land next to .kireo/project.json,
      // not drift to wherever the caller happened to invoke from.
      const root = repoRootOrCwd(cwd);
      writeContextMd(root, body);
    } catch (err) {
      ctx.logger.warn({ err }, 'tool.context_load.context_md_failed');
    }

    ctx.logger.info({ namespace: p.ctxNs, count: entries.length }, 'tool.context_load.ok');
    // Only claim a retry will happen for what is genuinely still pending, and
    // say plainly what this call already pushed — the old text promised an
    // automatic retry that no code path performed.
    const flushedNote = flushedEntries > 0 ? `\n\n✅ 已补传本地积压的 ${flushedEntries} 条。` : '';
    const suffix =
      pending > 0
        ? `\n\n⚠️ 本地还有 ${pending} 批未上传的上下文（这次也没传上去）。修好 API key / 网络 / 配额后，下次 save 或 resume 会再试。`
        : '';
    return toTextResult(`${body}${flushedNote}${suffix}`);
  },
});
