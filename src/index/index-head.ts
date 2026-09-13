import { MEMORY_LIMITS } from '@kireo/shared';
import { listItems } from '../context/list-envelope.js';
import type { RestClient } from '../rest/client.js';

/** Tag marking a commit-anchor card in a project's ctx bucket. */
export const INDEX_HEAD_TAG = 'k-index-head';

/**
 * Which index run an anchor belongs to.
 *
 * The anchor lives in the project's ctx bucket (it is metadata about the
 * index, not a symbol), but the symbols it describes live in a CODE bucket —
 * and one project can have several. `kireo index apps/api --repo api` and
 * `kireo index apps/web --repo web` share a git remote, therefore share a ctx
 * bucket, therefore used to share one anchor: the second run read the first
 * run's `@HEAD`, `git diff HEAD..HEAD` came back empty, and it uploaded zero
 * symbols while logging success. `code-web` stayed permanently empty. The same
 * bug fires on the much more common "ran `kireo index --repo myapp` once, then
 * plain `kireo index`" and on a second clone with a different directory name.
 *
 * So an anchor is keyed by (code namespace, index root) and only ever read or
 * swept within its own scope.
 */
export interface IndexHeadScope {
  /** The `code-*` namespace this run wrote symbols into. */
  codeNs: string;
  /** Index root, POSIX and relative to the repo root. '' = the repo root. */
  indexRoot: string;
}

export interface IndexHead {
  commit: string;
  ts: string;
  id: string;
}

interface HeadRow {
  id: string;
  tags?: string[];
  occurred_at: string;
  metadata?: Record<string, unknown>;
}

/**
 * All live anchor rows in `namespace`, unfiltered by scope and unsorted.
 *
 * GET /v1/memories offers no tag filter (see context-load.ts's `bucketOf`
 * comment for why), so this pages up to LIST_LIMIT_MAX rows and filters for
 * {@link INDEX_HEAD_TAG} client-side. Throws on transport/shape failures —
 * each caller decides how to degrade.
 *
 * The list array is `items`; `data` (what this used to read) does not exist on
 * this endpoint, so every anchor read silently returned [] — which made
 * `readIndexHead` a constant `null`: every `kireo index` degraded to a full
 * scan, and the sweep below never saw a row to retire, so each run left one
 * more permanent anchor card in the ctx bucket.
 */
async function listHeadRows(rest: RestClient, namespace: string): Promise<HeadRow[]> {
  const path = `/v1/memories?namespace=${encodeURIComponent(namespace)}&limit=${MEMORY_LIMITS.LIST_LIMIT_MAX}`;
  const res = await rest.request<{ items: HeadRow[] }>({ method: 'GET', path });
  return listItems<HeadRow>(res, path).filter((m) => (m.tags ?? []).includes(INDEX_HEAD_TAG));
}

/** A head row whose metadata still carries a usable commit string. */
const hasCommit = (row: HeadRow): boolean =>
  typeof row.metadata?.commit === 'string' && (row.metadata.commit as string).length > 0;

/**
 * An anchor written before scoping existed: no `code_ns`, so there is no way
 * to tell which code bucket it describes. Never read (that ambiguity is the
 * bug), always swept (otherwise it leaks forever).
 */
const isUnscoped = (row: HeadRow): boolean => typeof row.metadata?.code_ns !== 'string';

const matchesScope = (row: HeadRow, scope: IndexHeadScope): boolean =>
  row.metadata?.code_ns === scope.codeNs &&
  ((row.metadata?.index_root as string | undefined) ?? '') === scope.indexRoot;

/**
 * Deterministic winner among anchor rows: newest `occurred_at`, ties broken by
 * the lexicographically largest `id`. Read and write MUST share this exact
 * rule — it is what lets concurrent writers converge (see writeIndexHead).
 */
function newestHead(rows: HeadRow[]): HeadRow | null {
  let best: HeadRow | null = null;
  for (const row of rows) {
    if (
      best === null ||
      row.occurred_at.localeCompare(best.occurred_at) > 0 ||
      (row.occurred_at === best.occurred_at && row.id.localeCompare(best.id) > 0)
    ) {
      best = row;
    }
  }
  return best;
}

/**
 * Read the commit anchor for one (ctx bucket, code bucket, index root) triple.
 *
 * Should several live anchor rows exist at once for the same scope (two
 * devices finishing an index near-simultaneously — see writeIndexHead), the
 * {@link newestHead} rule picks one deterministically. Any failure — a network
 * error, a malformed response, no row with a usable commit — degrades to
 * `null`, mirroring `diffSince`'s "can't tell, let the caller fall back"
 * contract: a caller that can't read the anchor must fall back to a full scan,
 * not crash. An anchor written by an older client (no scope in its metadata)
 * also degrades to `null` — one extra full scan, then it gets replaced.
 */
export async function readIndexHead(
  rest: RestClient,
  namespace: string,
  scope: IndexHeadScope,
): Promise<IndexHead | null> {
  try {
    const rows = await listHeadRows(rest, namespace);
    const row = newestHead(rows.filter((r) => matchesScope(r, scope)).filter(hasCommit));
    if (!row) return null;
    return { commit: row.metadata?.commit as string, ts: row.occurred_at, id: row.id };
  } catch {
    return null;
  }
}

/**
 * Overwrite the commit anchor for one scope. It is metadata about the index,
 * not a symbol, so it belongs in the ctx bucket rather than the code bucket.
 *
 * Two-phase, convergent under concurrency (REST gives us no transaction):
 *
 * 1. CREATE the new anchor row first. If this fails, the previous anchor
 *    survives untouched — the old delete-then-create order could lose the
 *    anchor entirely when the create failed after the delete.
 * 2. SWEEP: list every live anchor row and soft-delete the ones this write
 *    supersedes — i.e. same-scope rows other than the {@link newestHead}
 *    winner, plus any unscoped legacy row (unusable, and nothing else will
 *    ever clean it up). Anchors belonging to a DIFFERENT scope are another
 *    code bucket's state and must survive.
 *
 * The old read→delete-one→create order was racy: two devices finishing an
 * index at the same time each read the same stale anchor, each deleted it,
 * and each created its own row — leaving TWO live rows forever. With the
 * sweep, the globally newest row in a scope can never lose a comparison in any
 * sweep that sees it, and the last sweep to list sees every surviving row, so
 * any interleaving of N concurrent writers ends with exactly one live row per
 * scope. A sweep may transiently overlap another writer's fresh row; that is
 * healed by whichever sweep runs last, and any leftovers from a crashed writer
 * are healed by the next successful write. The sweep itself is best-effort
 * cleanup: once the create succeeded the write has succeeded, so sweep
 * failures (including racing DELETEs on a row another sweep already removed)
 * are swallowed rather than turned into a failed write.
 */
export async function writeIndexHead(
  rest: RestClient,
  namespace: string,
  head: { commit: string; ts: string },
  scope: IndexHeadScope,
): Promise<void> {
  await rest.request({
    method: 'POST',
    path: '/v1/memories',
    body: {
      content: `index head @ ${head.commit} (${scope.codeNs}${scope.indexRoot ? `:${scope.indexRoot}` : ''})`,
      type: 'fact',
      namespace,
      tags: [INDEX_HEAD_TAG],
      occurred_at: head.ts,
      metadata: { commit: head.commit, code_ns: scope.codeNs, index_root: scope.indexRoot },
    },
  });

  try {
    const rows = await listHeadRows(rest, namespace);
    const mine = rows.filter((r) => matchesScope(r, scope));
    // The winner must carry a usable commit — a corrupt row never wins. With
    // no valid row visible (a stale read that misses our own create), delete
    // nothing in this scope rather than sweep blind; legacy rows are still
    // safe to retire either way.
    const winner = newestHead(mine.filter(hasCommit));
    const doomed = [
      ...(winner ? mine.filter((r) => r.id !== winner.id) : []),
      ...rows.filter(isUnscoped),
    ];
    for (const row of doomed) {
      try {
        await rest.request({
          method: 'DELETE',
          path: `/v1/memories/${encodeURIComponent(row.id)}`,
        });
      } catch {
        // A concurrent sweep may have removed it first; the next write heals
        // anything genuinely left behind.
      }
    }
  } catch {
    // Sweep is cleanup only — the anchor itself is already written.
  }
}
