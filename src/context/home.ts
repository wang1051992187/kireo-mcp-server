import { HOME_NAMESPACE, MEMORY_LIMITS } from '@kireo/shared';
import type { RestClient } from '../rest/client.js';
import { listItems } from './list-envelope.js';

/**
 * A row in the `kireo-home` namespace, as returned by GET /v1/memories.
 *
 * Only the fields this module reads — the rest of the memory record (type,
 * tags, importance, …) is irrelevant here.
 */
interface HomeRow {
  id: string;
  content?: string;
  occurred_at?: string;
  metadata?: {
    project_key?: unknown;
    display_name?: unknown;
    ctx_ns?: unknown;
  };
}

/** One project's cross-project summary card, as read back by `resume --all`. */
export interface HomeCard {
  projectKey: string;
  displayName: string;
  headline: string;
  ts: string;
}

/** All live rows in the fixed `kireo-home` bucket, unfiltered and unsorted. */
async function listHomeRows(rest: RestClient): Promise<HomeRow[]> {
  // `items`, not `data`. GET /v1/memories returns `{ items, next_cursor }`
  // (apps/api/src/memory/service.ts#ListResult, returned verbatim by
  // routes/memories.ts). Reading `data` here made this function return [] for
  // every caller: `resume --all` printed "no projects yet" forever, and
  // upsertHomeCard never saw the previous card so it never issued the DELETE
  // that keeps this bucket at one live card per project — the exact
  // unbounded-changelog degradation the doc comment below promises not to
  // allow. Every unit test in this package had mocked `data`, so nothing
  // caught it.
  const path = `/v1/memories?namespace=${encodeURIComponent(HOME_NAMESPACE)}&limit=${MEMORY_LIMITS.LIST_LIMIT_MAX}`;
  const res = await rest.request<{ items: HomeRow[]; next_cursor: string | null }>({
    method: 'GET',
    path,
  });
  return listItems<HomeRow>(res, path);
}

/**
 * Overwrite the single cross-project summary card for `opts.projectKey`.
 *
 * The `kireo-home` bucket holds AT MOST ONE live card per project — otherwise
 * `resume --all` degrades from "what am I doing right now, per project" into
 * an unbounded changelog. To keep that invariant, the previous card (if any)
 * is soft-deleted BEFORE the new one is written (order asserted by tests).
 *
 * Finding/deleting the old card is best-effort: a failure there (an unreadable
 * list, or a DELETE that 404s/errors) must never block writing the new card —
 * duplicating a card is a cosmetic annoyance, silently losing the "what am I
 * doing" signal for a project is not. Only the final POST is allowed to
 * surface as a thrown error to the caller.
 */
export async function upsertHomeCard(
  rest: RestClient,
  opts: { projectKey: string; displayName: string; ctxNs: string; headline: string },
): Promise<void> {
  try {
    const rows = await listHomeRows(rest);
    const stale = rows.filter((r) => r.metadata?.project_key === opts.projectKey);
    for (const row of stale) {
      try {
        await rest.request({
          method: 'DELETE',
          path: `/v1/memories/${encodeURIComponent(row.id)}`,
        });
      } catch {
        // Sooner a duplicate card than a missing one — see doc comment above.
      }
    }
  } catch {
    // Couldn't tell whether an old card exists; fall through and write the
    // new one anyway rather than skip the update entirely.
  }

  await rest.request({
    method: 'POST',
    path: '/v1/memories',
    body: {
      content: opts.headline,
      type: 'fact',
      namespace: HOME_NAMESPACE,
      metadata: {
        project_key: opts.projectKey,
        display_name: opts.displayName,
        ctx_ns: opts.ctxNs,
      },
    },
  });
}

/** All cross-project summary cards, most-recently-updated first. */
export async function listHomeCards(rest: RestClient): Promise<HomeCard[]> {
  const rows = await listHomeRows(rest);
  return rows
    .filter(
      (r): r is HomeRow & { metadata: { project_key: string } } =>
        typeof r.metadata?.project_key === 'string',
    )
    .map((r) => ({
      projectKey: r.metadata.project_key,
      displayName:
        typeof r.metadata.display_name === 'string'
          ? r.metadata.display_name
          : r.metadata.project_key,
      headline: r.content ?? '',
      ts: r.occurred_at ?? '',
    }))
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}
