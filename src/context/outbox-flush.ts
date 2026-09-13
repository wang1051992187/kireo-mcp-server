import { join } from 'node:path';
import { logsDir } from '../lib/platform.js';
import type { RestClient } from '../rest/client.js';
import { completeBatchAck } from './archive.js';
import { type OutboxRecord, dropOutbox, listOutbox } from './outbox.js';
import { appendOutboundAudit, outboundDigests } from './redact.js';

/**
 * Cap per invocation. A user who has been offline for a fortnight should not
 * pay a 40-request stall at the head of the next `/kireo:save`; whatever is
 * left is picked up by the save/resume after this one.
 */
const MAX_RECORDS_PER_FLUSH = 20;

export interface FlushResult {
  /** Outbox records uploaded and removed from disk. */
  flushed: number;
  /** Entries inside those records. */
  entries: number;
  /** Records still on disk afterwards. */
  remaining: number;
}

interface BatchAck {
  succeeded: { index: number; id: string; deduped?: boolean }[];
  failures: { index: number; code: string; message: string }[];
}

interface OutboxItem {
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * Re-upload everything sitting in the local outbox, oldest first.
 *
 * The outbox was write-only: `writeOutbox` on every save, `dropOutbox` only on
 * the SAME call's success, `listOutbox` used purely to count. Nothing anywhere
 * ever read `rec.entries` back and posted it — while spec §11 ("outbox 留存,
 * 下次 save 与 resume 自动 flush"), the save tool's own return text, the resume
 * banner and `kireo doctor`'s hint all told the user it would be retried. A
 * user who saved on a plane and reconnected got that promise repeated at them
 * indefinitely while the eight entries stayed in ~/.kireo/outbox forever.
 *
 * Contract:
 *  - Never throws. A flush is opportunistic housekeeping in front of the
 *    operation the user actually asked for; an unreachable API must degrade to
 *    "still pending", never to a failed save or a failed resume.
 *  - Stops at the FIRST failing record. If the API is down, the remaining
 *    records will fail identically, and burning 20 timeouts before the user's
 *    own save would be worse than leaving them for next time.
 *  - A record is dropped only on a fully clean ack (`failures` empty), so a
 *    partial batch stays on disk and gets retried whole. The server dedupes by
 *    (namespace, content_hash), so re-sending what already landed creates no
 *    duplicates and costs no write quota.
 *  - `supersedes` deletes replay only AFTER their entries are safely stored —
 *    same ordering rule as context_save.
 */
export async function flushOutbox(
  rest: RestClient,
  dir: string,
  opts: { auditLogPath?: string; onError?: (err: unknown, path: string) => void } = {},
): Promise<FlushResult> {
  let records: { path: string; rec: OutboxRecord }[];
  try {
    records = listOutbox(dir);
  } catch (err) {
    opts.onError?.(err, dir);
    return { flushed: 0, entries: 0, remaining: 0 };
  }

  let flushed = 0;
  let entries = 0;
  for (const { path, rec } of records.slice(0, MAX_RECORDS_PER_FLUSH)) {
    const items = Array.isArray(rec.entries) ? (rec.entries as OutboxItem[]) : [];
    if (items.length === 0) {
      // Nothing to send and nothing to lose — retire it instead of leaving a
      // record that can never clear and eventually trips doctor's backlog fail.
      dropOutbox(path);
      flushed++;
      continue;
    }
    try {
      const res = await rest.request<BatchAck>({
        method: 'POST',
        path: '/v1/memories/batch',
        body: { items, strict: false },
      });
      if (!completeBatchAck(res, items.length)) break;

      appendOutboundAudit(opts.auditLogPath ?? join(logsDir(), 'outbound.jsonl'), {
        ts: new Date().toISOString(),
        namespace: rec.namespace,
        count: items.length,
        digests: outboundDigests(items),
      });

      for (const id of rec.supersedes ?? []) {
        try {
          await rest.request({
            method: 'DELETE',
            path: `/v1/memories/${encodeURIComponent(id)}`,
          });
        } catch (err) {
          // A superseded id that no longer exists (or a transient failure) must
          // not keep the whole record pending — its replacement is stored.
          opts.onError?.(err, path);
        }
      }

      dropOutbox(path);
      flushed++;
      entries += items.length;
    } catch (err) {
      opts.onError?.(err, path);
      break;
    }
  }

  return { flushed, entries, remaining: Math.max(0, records.length - flushed) };
}
