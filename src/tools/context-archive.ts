import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEMORY_LIMITS } from '@kireo/shared';
import { z } from 'zod';
import { archiveChunks, archiveProject, completeBatchAck, digest } from '../context/archive.js';
import { flushOutbox } from '../context/outbox-flush.js';
import { dropOutbox, writeOutbox } from '../context/outbox.js';
import { repoRootOrCwd } from '../context/project.js';
import { appendOutboundAudit, isDisabled, outboundDigests, redact } from '../context/redact.js';
import { defineTool, toJsonResult } from './shared.js';

const Input = z
  .object({
    cwd: z
      .string()
      .min(1)
      .describe('Absolute directory of THIS conversation; always pass it explicitly.'),
    summary: z
      .string()
      .trim()
      .min(1)
      .max(64_000)
      .describe(
        'Markdown semantically compressed by the host from all requested conversation rounds. ' +
          'Preserve goals, decisions and reasons, constraints, results, corrections and unfinished work. ' +
          'Do not pass raw logs or invent missing history.',
      ),
    host: z.enum(['codex', 'claude-code']),
    session_id: z.string().min(1).max(200),
    dry_run: z
      .boolean()
      .default(false)
      .describe('Preview exact redacted upload without disk or network writes.'),
  })
  .strict();

export const contextArchiveTool = defineTool<z.infer<typeof Input>>({
  name: 'context_archive',
  description: [
    'Save and upload a semantically compressed conversation as <directory-name>.md.',
    'When to use: after /kireo:compact has summarized the requested conversation rounds,',
    'and the user has asked to upload them. The host model does the compression; this tool',
    'redacts, writes the Markdown file, splits it losslessly and uploads it to the memory API.',
    'Always pass the conversation directory as cwd. Directory archives use their own namespace',
    '(different worktrees and same-named directories stay separate) and never change relay project keys.',
    'dry_run:true previews without side effects; otherwise invocation saves AND uploads.',
    'A failed or incomplete upload stays queued locally. Run compact again to retry.',
    'Returns the project, filename, local_path, namespace, snapshot_id, stored, deduped,',
    'outbox_pending, memory_ids and dashboard_url. Never call a queued archive uploaded.',
  ].join('\n'),
  schema: Input,
  handler: async (rawInput, ctx) => {
    const cwd = typeof rawInput?.cwd === 'string' ? rawInput.cwd : process.cwd();
    if (isDisabled(cwd, process.env) || isDisabled(repoRootOrCwd(cwd), process.env)) {
      return toJsonResult({ disabled: true }, 'kireo 隐私开关已启用，本次未压缩归档或上传');
    }
    const input = Input.parse(rawInput);
    const project = archiveProject(input.cwd);
    const content = redact(input.summary).text;
    const snapshotId = digest(content);
    const localPath = join(project.archiveDir, snapshotId, project.filename);
    // The server dedupes on content, not metadata. A snapshot/part marker prevents
    // identical paragraphs in different versions from losing their file association.
    const chunks = archiveChunks(content, MEMORY_LIMITS.CONTENT_MAX - 160);
    const items = chunks.map((chunk, index) => ({
      content: `${chunk}\n\n<!-- kireo-archive ${snapshotId} part ${index + 1}/${chunks.length} -->`,
      type: 'other',
      namespace: project.namespace,
      tags: ['kireo-archive', `snapshot-${snapshotId.slice(0, 16)}`],
      importance: 0.8,
      metadata: {
        project: project.name,
        file_path: project.filename,
        filename: project.filename,
        snapshot_id: snapshotId,
        chunk_index: index,
        chunk_count: chunks.length,
        host: input.host,
        session_id: redact(input.session_id).text,
        compression: 'host-semantic',
      },
    }));
    const destination = {
      project: project.name,
      filename: project.filename,
      local_path: localPath,
      namespace: project.namespace,
      snapshot_id: snapshotId,
      chunks: chunks.length,
    };
    if (input.dry_run) {
      return toJsonResult({ ...destination, dry_run: true, items }, '压缩归档预览，尚未写入或上传');
    }

    // Each version has its own directory; repeated saves never destroy an older summary.
    const snapshotDir = join(project.archiveDir, snapshotId);
    mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
    const ignorePath = join(project.archiveDir, '.gitignore');
    if (!existsSync(ignorePath)) writeFileSync(ignorePath, '*\n!.gitignore\n', { mode: 0o600 });
    writeFileSync(localPath, content, { mode: 0o600 });
    const outboxDir = join(project.archiveDir, 'outbox');
    const auditPath = join(project.archiveDir, 'outbound.jsonl');
    const replay = await flushOutbox(ctx.rest, outboxDir, {
      auditLogPath: auditPath,
      onError: (err) => ctx.logger.warn({ err }, 'tool.context_archive.retry_failed'),
    });
    const outboxPath = writeOutbox(outboxDir, {
      ts: new Date().toISOString(),
      namespace: project.namespace,
      entries: items,
    });
    let stored = 0;
    let deduped = 0;
    let pending = true;
    let memoryIds: string[] = [];
    try {
      // Record attempted outbound payloads, including an HTTP failure after sending.
      appendOutboundAudit(auditPath, {
        ts: new Date().toISOString(),
        namespace: project.namespace,
        count: items.length,
        digests: outboundDigests(items),
      });
      const result = await ctx.rest.request<{
        succeeded: { index: number; id: string; deduped?: boolean }[];
        failures: { index: number; code: string; message: string }[];
      }>({ method: 'POST', path: '/v1/memories/batch', body: { items, strict: false } });
      if (completeBatchAck(result, items.length)) {
        stored = result.succeeded.filter((entry) => !entry.deduped).length;
        deduped = result.succeeded.length - stored;
        memoryIds = [...result.succeeded]
          .sort((a, b) => a.index - b.index)
          .map((entry) => entry.id);
        dropOutbox(outboxPath);
        pending = false;
      }
    } catch (err) {
      ctx.logger.warn({ err }, 'tool.context_archive.upload_pending');
    }
    return toJsonResult(
      {
        ...destination,
        stored,
        deduped,
        memory_ids: memoryIds,
        outbox_pending: pending,
        previous_pending: replay.remaining,
        retried_entries: replay.entries,
        dashboard_url: `https://app.kireo.app/app/memories?namespace=${project.namespace}`,
      },
      pending
        ? `已保存 ${project.filename} 到本地，上传未完整确认；下次 compact 自动补传`
        : `已上传 ${project.filename}（${chunks.length} 段），项目 = ${project.name}`,
    );
  },
});
