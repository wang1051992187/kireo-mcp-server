import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type ContextBucket,
  ContextEntrySchema,
  MEMORY_LIMITS,
  bucketToMemoryType,
  contextTags,
} from '@kireo/shared';
import { z } from 'zod';
import { upsertHomeCard } from '../context/home.js';
import { flushOutbox } from '../context/outbox-flush.js';
import { dropOutbox, writeOutbox } from '../context/outbox.js';
import { repoRootOrCwd, resolveProjectHere } from '../context/project.js';
import { appendOutboundAudit, isDisabled, outboundDigests, redact } from '../context/redact.js';
import { scoreEntry } from '../context/score.js';
import { locateTranscript } from '../context/transcript-locate.js';
import { parseClaudeTranscript, parseCodexRollout } from '../context/transcript.js';
import { verifyEvidence } from '../context/verify.js';
import { logsDir } from '../lib/platform.js';
import { type ToolContext, defineTool, toJsonResult } from './shared.js';

/**
 * First-run acknowledgement marker, kept NEXT TO the outbox directory (its
 * parent). While this file is absent, every call is forced into a preview —
 * see the handler. It sits by the outbox (not in some global config dir) so
 * tests control first-run state purely through `outbox_dir`, and so wiping
 * one outbox location re-arms the gate for that location only.
 */
const FIRST_RUN_MARKER = '.first-run-acknowledged';
const firstRunMarkerPath = (outboxDir: string): string =>
  join(dirname(outboxDir), FIRST_RUN_MARKER);

const Input = z
  .object({
    entries: z.array(ContextEntrySchema).min(1).max(MEMORY_LIMITS.BATCH_MAX),
    host: z.string().min(1).describe('Which host produced this: "claude-code" or "codex".'),
    session_id: z.string().min(1),
    cwd: z.string().optional(),
    outbox_dir: z.string().optional(),
    audit_log_path: z.string().optional(),
    dry_run: z
      .boolean()
      .optional()
      .describe(
        'Preview only: apply redaction and show the exact text that would leave this ' +
          'device, without writing the outbox or uploading anything. Deliberately has NO ' +
          'schema default, so after parsing three states stay distinguishable: omitted ' +
          '(undefined), explicit false, explicit true. On the very first run (no ' +
          '`.first-run-acknowledged` marker next to the outbox dir) omitting it forces a ' +
          'preview; only an explicit `dry_run: false` performs the real save and records ' +
          'the acknowledgement. Once the marker exists, omitted and false both perform a ' +
          'real save; `true` always previews.',
      ),
    uncertain_indexes: z
      .array(z.number().int().min(0))
      .default([])
      .describe(
        'Indexes of entries you are not fully confident in. These are UNIONed with ' +
          'whatever the transcript evidence check flags, and render as [uncertain] on ' +
          'the resume side.',
      ),
    transcript_path: z
      .string()
      .optional()
      .describe(
        "Absolute path to THIS session's transcript (.jsonl). Used for the literal " +
          'evidence check: file paths and commands cited in `evidence` that never ' +
          'appear in the session mark that entry [uncertain]. Optional — for ' +
          'claude-code it is located automatically from `session_id`; verification is ' +
          'skipped (never blocked) when no transcript can be read.',
      ),
  })
  .strict();

type InputT = z.infer<typeof Input>;

/** Trim metadata to METADATA_BYTES_MAX by dropping files first, then evidence. */
const fitMetadata = (meta: Record<string, unknown>): Record<string, unknown> => {
  const size = (o: unknown) => Buffer.byteLength(JSON.stringify(o));
  const out = { ...meta };
  if (size(out) <= MEMORY_LIMITS.METADATA_BYTES_MAX) return out;

  const files = Array.isArray(out.files) ? [...(out.files as string[])] : [];
  while (files.length > 0 && size({ ...out, files }) > MEMORY_LIMITS.METADATA_BYTES_MAX) {
    files.pop();
  }
  out.files = files;
  if (size(out) <= MEMORY_LIMITS.METADATA_BYTES_MAX) return out;

  // Evidence is more valuable than files, so it goes last — truncated, not dropped.
  if (typeof out.evidence === 'string') {
    let ev = out.evidence;
    while (ev.length > 0 && size({ ...out, evidence: ev }) > MEMORY_LIMITS.METADATA_BYTES_MAX) {
      ev = ev.slice(0, Math.max(0, ev.length - 64));
    }
    out.evidence = ev;
  }
  return out;
};

/**
 * The one-line "what am I doing right now" for the kireo-home card: the
 * highest-scored `open` entry from this save, or — when there is none — the
 * highest-scored `decision`. All entries are being saved right now, so
 * `scoreEntry` sees zero age for every candidate; it still matters because it
 * also weighs bucket and importance, and it keeps this in sync with how
 * `context_load`/`renderContext` rank entries everywhere else. `null` when
 * neither bucket is present in this save — nothing to headline yet.
 */
const pickHeadline = (
  entries: { bucket: ContextBucket; importance: number; content: string }[],
  now: Date,
): string | null => {
  const best = (bucket: ContextBucket): string | null => {
    let bestContent: string | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const e of entries) {
      if (e.bucket !== bucket) continue;
      const score = scoreEntry(
        { bucket: e.bucket, importance: e.importance, occurredAt: now.toISOString() },
        now,
      );
      if (score > bestScore) {
        bestScore = score;
        bestContent = e.content;
      }
    }
    return bestContent;
  };
  return best('open') ?? best('decision');
};

export const contextSaveTool = defineTool<InputT>({
  name: 'context_save',
  description: [
    'Persist distilled session context for the current project.',
    '',
    'When to use: ONCE per /kireo:save, after you have distilled the session.',
    'Always call project_info first and show the user the resolved project.',
    '',
    'Each entry needs non-empty `evidence` — a concrete basis from THIS session',
    '(a file path, a command you ran, something the user said). If you cannot',
    'cite one, do not write the entry.',
    '',
    'Do NOT store things re-derivable from the repo in 60 seconds — that is the',
    'code index’s job. Store decisions, constraints, gotchas, open threads,',
    'a small map of key files, and stated preferences.',
    '',
    'Privacy: content, evidence, and files are pattern-redacted for known',
    'credential shapes, but that is NOT a privacy guarantee — it cannot catch',
    'business secrets ("customer A’s contract is worth $X") that got paraphrased',
    'into evidence/files from things the session read (.env, docker logs, a',
    'pasted SQL result). The first run is therefore FORCED into a preview by the',
    'tool itself: until a `.first-run-acknowledged` marker exists next to the',
    'outbox directory, every call returns the exact (post-redaction) text and',
    'writes/uploads nothing, no matter what `dry_run` says. Show that text to',
    'the user, and only after they confirm there is nothing business-sensitive',
    'call again with an explicit `dry_run: false` — that call performs the real',
    'save and records the acknowledgement. From then on `dry_run` is an ordinary',
    'optional preview flag (omitted = real save). A repo with a `.kireo/disabled`',
    'file, or the KIREO_DISABLED env var, disables this tool entirely — it',
    'returns immediately and does nothing.',
    '',
    'Returns: { stored, deduped, failed, outbox_pending, namespace, dashboard_url }',
  ].join('\n'),
  schema: Input,
  handler: async (rawInput, ctx: ToolContext) => {
    // Kill switch is checked BEFORE anything else — including input
    // validation — because a hit must mean "do nothing at all", not "do
    // nothing except throw a validation error". A repo-level `.kireo/disabled`
    // file or the KIREO_DISABLED env var both work; either fires this.
    const cwdForKillSwitch =
      (typeof rawInput === 'object' && rawInput !== null && 'cwd' in rawInput
        ? (rawInput as { cwd?: unknown }).cwd
        : undefined) ?? process.cwd();
    if (
      isDisabled(
        repoRootOrCwd(typeof cwdForKillSwitch === 'string' ? cwdForKillSwitch : process.cwd()),
        process.env,
      )
    ) {
      return toJsonResult(
        { disabled: true },
        'Kireo is disabled (.kireo/disabled or KIREO_DISABLED). No action was taken',
      );
    }

    // Re-validate even though the MCP dispatch layer already runs
    // `tool.zod.safeParse` before calling handlers (see server.ts) — this
    // handler is also exercised directly in tests, and `evidence` empty is
    // exactly the anti-hallucination guard ContextEntrySchema exists to
    // enforce (see context-schema.ts). Must run before any side effect
    // (outbox write, network call).
    const input = Input.parse(rawInput);
    const p = resolveProjectHere(input.cwd ?? process.cwd());

    // Spec §6.2[4], finally wired up. `verifyEvidence` existed with a full
    // unit-test suite and ZERO production callers, and neither host's save
    // prompt ever mentioned `uncertain_indexes` — so `uncertain` was
    // permanently the empty set, `metadata.uncertain` permanently false, and
    // render.ts's `[uncertain]` marker unreachable. Meanwhile both resume
    // prompts tell the model "no marker = the evidence was checked". Every
    // fabricated card was therefore delivered downstream as confirmed fact,
    // and spec §14.2 names exactly that ("turning a discussion into a
    // decision") as this feature's most dangerous failure mode with the
    // marker as its only mitigation.
    //
    // Degrades OPEN at every step: no path, unreadable file, unknown format —
    // verification is skipped, never blocking the save (spec: "格式探测失败 →
    // 跳过校验 + 显式警告，绝不阻断").
    const uncertain = new Set(input.uncertain_indexes);
    const transcriptPath =
      input.transcript_path ??
      locateTranscript(input.host, input.session_id, input.cwd ?? process.cwd());
    if (transcriptPath) {
      try {
        const text = readFileSync(transcriptPath, 'utf8');
        const turns =
          input.host === 'codex' ? parseCodexRollout(text) : parseClaudeTranscript(text);
        const verified = verifyEvidence(
          input.entries.map((e) => ({ evidence: e.evidence, files: e.files })),
          turns,
        );
        verified.forEach((ok, i) => {
          if (!ok) uncertain.add(i);
        });
      } catch (err) {
        ctx.logger.warn({ err, transcriptPath }, 'tool.context_save.evidence_verification_skipped');
      }
    }

    // Resolved up front (not at write-ahead time) because it anchors the
    // first-run marker below, which must be known before any branching.
    const outboxDir = input.outbox_dir ?? `${process.env.HOME ?? '.'}/.kireo/outbox`;

    // First-run forced preview — runtime state, not a schema default. The
    // spec's "first run must dry-run" is a ONE-TIME gate; flipping the
    // dry_run default to true instead (tried once, reverted) either breaks
    // every existing caller (none pass dry_run:false) or turns the tool
    // preview-only forever. So: while the marker is absent, EVERY call is
    // forced into preview unless dry_run is an explicit false — the
    // affirmative "a human saw the preview and confirmed" signal — which
    // performs a real save and writes the marker.
    //
    // Explicitness must SURVIVE PARSING, which is why `dry_run` carries no
    // zod default: the production dispatch (server.ts) hands handlers
    // `safeParse(...).data`, never the raw arguments, and a `.default(false)`
    // would backfill an omitted dry_run into a literal `false` during that
    // parse — making "omitted" and "explicit false" indistinguishable here
    // and turning this gate into dead code. (That was exactly the round-1
    // bug: a `'dry_run' in rawInput` check that only worked when tests
    // bypassed the parse.) Without a default, `undefined` (omitted) /
    // `false` (explicit) / `true` (preview) stay three distinct states no
    // matter how many times the input is parsed.
    const markerPath = firstRunMarkerPath(outboxDir);
    const firstRun = !existsSync(markerPath);

    // Pattern-redact known credential shapes out of everything that leaves the
    // device — content, evidence, AND files. `files` rides into
    // `metadata.files` in the same upload body, so it is the same leak path
    // (a session that ran `cat .env` paraphrases into any of the three) and
    // gets the same per-string treatment. This is NOT a privacy guarantee
    // (see redact.ts) — it is a floor, not a ceiling. The preview gates below
    // are the actual backstop for the business secrets this cannot catch.
    const redacted = input.entries.map((e) => ({
      ...e,
      content: redact(e.content).text,
      evidence: redact(e.evidence).text,
      files: e.files.map((f) => redact(f).text),
    }));

    const items = redacted.map((e, i) => ({
      content: e.content,
      type: bucketToMemoryType(e.bucket),
      namespace: p.ctxNs,
      tags: contextTags(e.bucket, input.host, input.session_id),
      importance: e.importance,
      metadata: fitMetadata({
        bucket: e.bucket,
        evidence: e.evidence,
        files: e.files,
        host: input.host,
        session_id: input.session_id,
        uncertain: uncertain.has(i),
      }),
    }));

    if (firstRun && input.dry_run !== false) {
      // No acknowledgement marker yet: unconditionally preview. Any dry_run
      // value other than an explicit false (i.e. omitted/undefined or true)
      // lands here on purpose. Nothing below this return may run — no outbox
      // write, no upload, no audit append, and the marker is NOT created
      // here (only a real, explicitly-confirmed save creates it).
      return toJsonResult(
        {
          dry_run: true,
          first_run: true,
          namespace: p.ctxNs,
          entries: items.map((it) => ({
            content: it.content,
            metadata: it.metadata,
          })),
        },
        `[First-run preview] ${items.length} entries are intended for ${p.ctxNs}. Recognized credentials were redacted; business-sensitive content has not been assessed. Show this exact preview and obtain confirmation before calling with dry_run:false. Nothing was queued, uploaded, or added to the audit log.`,
      );
    }

    if (input.dry_run === true) {
      // Show the exact (post-redaction) text as-is — the whole point is
      // letting a human catch what pattern-redaction cannot: business
      // secrets that got paraphrased into evidence/files this session.
      // Nothing is written or uploaded from here.
      return toJsonResult(
        {
          dry_run: true,
          namespace: p.ctxNs,
          entries: items.map((it) => ({
            content: it.content,
            metadata: it.metadata,
          })),
        },
        `[dry-run] Preview of ${items.length} entries for ${p.ctxNs}. Recognized credentials were redacted; review business-sensitive content before uploading. Show the exact preview and call with dry_run:false only when authorized.`,
      );
    }

    if (firstRun) {
      // Reaching here means dry_run was explicitly false — the "a human
      // confirmed the preview" signal. Record the acknowledgement BEFORE the
      // upload: it is about the human confirmation having happened, not about
      // upload success (the outbox below already owns upload-failure
      // durability), so a failed upload must not re-arm the forced preview.
      mkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 });
      writeFileSync(markerPath, `${new Date().toISOString()}\n`, { mode: 0o600 });
    }

    // Retry whatever earlier saves left behind BEFORE adding to the pile —
    // oldest context first, and the outbox never grows without anything ever
    // draining it. Best-effort: this is not what the user asked for.
    let flushedEntries = 0;
    try {
      const flushed = await flushOutbox(ctx.rest, outboxDir, {
        ...(input.audit_log_path ? { auditLogPath: input.audit_log_path } : {}),
        onError: (err) => ctx.logger.warn({ err }, 'tool.context_save.outbox_flush_failed'),
      });
      flushedEntries = flushed.entries;
    } catch (err) {
      ctx.logger.warn({ err }, 'tool.context_save.outbox_flush_failed');
    }

    const supersedes = input.entries.flatMap((e) => e.supersedes);

    // Write-ahead: the record survives any upload failure below. `supersedes`
    // rides along so a later flush can still retire what this save overturned
    // — without it, a replayed record would resurrect the duplicate.
    const outboxPath = writeOutbox(outboxDir, {
      ts: new Date().toISOString(),
      namespace: p.ctxNs,
      entries: items,
      ...(supersedes.length > 0 ? { supersedes } : {}),
    });

    let stored = 0;
    let deduped = 0;
    let failed = 0;
    let pending = false;

    try {
      // Field name is `failures`, not `failed` — see BatchCreateResponse in
      // rest/types.ts, the same-package caller in index/run-index.ts, and the
      // server-side return in apps/api/src/memory/service.ts. Getting this
      // wrong throws on `res.failed.length` (undefined), which the catch below
      // swallows and permanently misreports every successful upload as pending.
      const res = await ctx.rest.request<{
        succeeded: { index: number; id: string; deduped?: boolean }[];
        failures: { index: number; code: string; message: string }[];
      }>({ method: 'POST', path: '/v1/memories/batch', body: { items, strict: false } });

      for (const s of res.succeeded) s.deduped ? deduped++ : stored++;
      failed = res.failures.length;
      if (failed === 0) dropOutbox(outboxPath);
      else pending = true;

      // Audit AFTER the upload: the batch left the device in the request body
      // above regardless of any per-item `failures` in the response, so this
      // records what was actually sent — summary only, never content (see
      // redact.ts: sha256 prefix + short preview per entry). The digest
      // covers `metadata.files` too, not just `content`: files travels in
      // the same upload body, and leaving it out would let a files-only leak
      // depart the device with zero trace in this log.
      const auditPath = input.audit_log_path ?? join(logsDir(), 'outbound.jsonl');
      appendOutboundAudit(auditPath, {
        ts: new Date().toISOString(),
        namespace: p.ctxNs,
        count: items.length,
        digests: outboundDigests(items),
      });
    } catch (err) {
      // Never surface this as a hard failure: the record is on disk and the
      // next save or resume flushes it. Losing it here is the failure mode
      // that destroys the "I saved it" mental model.
      ctx.logger.warn({ err, namespace: p.ctxNs }, 'tool.context_save.upload_failed');
      pending = true;
    }

    // NEVER delete the old entries when the new ones did not land.
    //
    // This loop used to run unconditionally, right after a catch that
    // swallowed the upload error. So on a 402 (free tier's 200 writes/month
    // exhausted), on a dropped connection, on a VM restart: the batch POST
    // failed, `pending` was set, and then every `supersedes` id was
    // successfully DELETEd anyway — DELETE /memories/:id deliberately carries
    // no write-quota guard (routes/memories.ts: "删除减少用量，绝不能挂写配额")
    // while POST /memories/batch does. Net effect was a strict LOSS of
    // context: the overturned entries gone, their replacements never stored,
    // and the summary mentioning neither. The deletes now wait in the outbox
    // record and replay with the entries they supersede.
    let superseded = 0;
    if (pending) {
      if (supersedes.length > 0) {
        ctx.logger.warn(
          { count: supersedes.length, namespace: p.ctxNs },
          'tool.context_save.supersede_deferred_upload_pending',
        );
      }
    } else {
      for (const id of supersedes) {
        try {
          await ctx.rest.request({
            method: 'DELETE',
            path: `/v1/memories/${encodeURIComponent(id)}`,
          });
          superseded++;
        } catch (err) {
          ctx.logger.warn({ err, id }, 'tool.context_save.supersede_failed');
        }
      }
    }

    // Cross-project overview card, best-effort: this save's headline is not
    // the reason the user called context_save, so a failure here must never
    // surface as this tool's failure — only a warn, same spirit as the
    // upload-failure catch above.
    const headline = pickHeadline(redacted, new Date());
    if (headline) {
      try {
        await upsertHomeCard(ctx.rest, {
          projectKey: p.key,
          displayName: p.displayName,
          ctxNs: p.ctxNs,
          headline,
        });
      } catch (err) {
        ctx.logger.warn({ err, namespace: p.ctxNs }, 'tool.context_save.home_card_failed');
      }
    }

    const flushedNote = flushedEntries > 0 ? ` · Retried ${flushedEntries} queued entries` : '';
    const summary = pending
      ? `Saved ${items.length} entries locally (upload pending; save/resume will retry)${
          supersedes.length > 0
            ? ` · ${supersedes.length} superseded entries will be removed after this batch uploads`
            : ''
        }${flushedNote} · Project: ${p.displayName}`
      : `Saved ${stored} entries${deduped ? ` · Deduplicated ${deduped} entries` : ''}${superseded ? ` · Soft-deleted ${superseded} superseded entries` : ''}${flushedNote} · Project: ${p.displayName}`;

    return toJsonResult(
      {
        stored,
        deduped,
        failed,
        superseded,
        outbox_pending: pending,
        namespace: p.ctxNs,
        dashboard_url: `https://app.kireo.app/app/memories?namespace=${p.ctxNs}`,
      },
      summary,
    );
  },
});
