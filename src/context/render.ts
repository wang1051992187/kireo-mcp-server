import type { ContextBucket } from '@kireo/shared';
import { scoreEntry } from './score.js';

export interface RenderableEntry {
  id: string;
  bucket: ContextBucket;
  content: string;
  occurredAt: string;
  importance: number;
  host: string;
  uncertain: boolean;
}

export interface RenderMeta {
  projectKey: string;
  source: string;
  indexCommit: string | null;
  indexAgeDays: number | null;
  /**
   * True when the reader stopped paging before the list was exhausted, i.e.
   * `entries` is not everything stored for this project. Reported in the
   * header so "I only see 200 of them" never reads as "that is all there is".
   */
  moreBeyondFetched?: boolean;
}

/** Fixed order: hard limits first, then what to do next, then background. */
const GROUPS: { bucket: ContextBucket; title: string }[] = [
  { bucket: 'constraint', title: 'Constraints' },
  { bucket: 'open', title: 'Open threads' },
  { bucket: 'decision', title: 'Decisions' },
  { bucket: 'gotcha', title: 'Gotchas' },
  { bucket: 'map', title: 'Key files' },
  { bucket: 'pref', title: 'Preferences' },
];

const STALE_OPEN_DAYS = 90;
const DEFAULT_TOKEN_BUDGET = 1200;
/** Rough chars-per-token; only used to keep the budget honest. */
const CHARS_PER_TOKEN = 4;

const ageDays = (iso: string, now: Date): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : Math.max(0, (now.getTime() - t) / 86400_000);
};

export const renderContext = (
  entries: RenderableEntry[],
  meta: RenderMeta,
  now: Date,
  tokenBudget = DEFAULT_TOKEN_BUDGET,
): string => {
  // Index freshness is deliberately unconditional. Omitting it is the single
  // most misleading thing this renderer could do: the model otherwise assumes
  // the code index reflects the working tree.
  const freshness =
    meta.indexCommit && meta.indexAgeDays !== null
      ? `code index @ ${meta.indexCommit} (${Math.round(meta.indexAgeDays)}d stale)`
      : 'no code index yet';

  const ranked = [...entries].sort((a, b) => scoreEntry(b, now) - scoreEntry(a, now));

  // Header is built AFTER the budget pass because it has to state how many of
  // the entries actually made it. Its own length is approximated first (the
  // "showing K of N" form is a handful of chars longer, well inside the 40-char
  // per-entry slack) so the budget arithmetic stays honest.
  const headPrefix = `project ${meta.projectKey} (via ${meta.source}) · ${freshness} · `;

  const budgetChars = tokenBudget * CHARS_PER_TOKEN;
  const kept: RenderableEntry[] = [];
  let used = headPrefix.length + 24;
  for (const e of ranked) {
    const cost = e.content.length + 40; // markers, age, host
    // Entries are sorted by score descending, so the first one that doesn't
    // fit marks the cutoff: `continue`-ing past it would let a lower-scoring
    // but shorter entry later in the list sneak into the budget ahead of a
    // higher-scoring entry that was skipped, silently inverting the ranking
    // this loop exists to enforce.
    if (used + cost > budgetChars) break;
    kept.push(e);
    used += cost;
  }

  // Budget truncation must be VISIBLE.
  //
  // The header used to report `entries.length` while the body rendered only
  // what fit, and a group whose every entry was dropped lost its heading too.
  // With a 1200-token budget and 41 stored entries that means a header saying
  // "41 entries", 13 bullets, and NO `## Constraints` section at all — from
  // which the only available inference is "this project has no hard
  // constraints". A model then does the thing the missing constraint forbade.
  // Spec §14.2 calls injecting a constraint that does not exist worse than no
  // context; this was its mirror image, and just as silent.
  const omittedByBucket = new Map<ContextBucket, number>();
  for (const e of ranked.slice(kept.length)) {
    omittedByBucket.set(e.bucket, (omittedByBucket.get(e.bucket) ?? 0) + 1);
  }
  const omittedTotal = ranked.length - kept.length;

  const countPart =
    omittedTotal > 0
      ? `showing ${kept.length} of ${entries.length} entries`
      : `${entries.length} entries`;
  const morePart = meta.moreBeyondFetched ? ' · 仓库里还有更多未读取' : '';
  const header = `${headPrefix}${countPart}${morePart}`;

  const lines: string[] = [header, ''];
  for (const g of GROUPS) {
    const inGroup = kept.filter((e) => e.bucket === g.bucket);
    const omitted = omittedByBucket.get(g.bucket) ?? 0;
    if (inGroup.length === 0 && omitted === 0) continue;
    lines.push(`## ${g.title}`);
    for (const e of inGroup) {
      const d = ageDays(e.occurredAt, now);
      const flags = [
        e.uncertain ? '[uncertain]' : '',
        e.bucket === 'open' && d > STALE_OPEN_DAYS ? '[stale]' : '',
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(
        `- ${e.content} ${flags} [${Math.round(d)}d ago · ${e.host}]`.replace(/\s+/g, ' '),
      );
    }
    if (omitted > 0) {
      lines.push(
        `- … 另有 ${omitted} 条${g.title} 因 token 预算未展示（用更大的 token_budget 重跑）`,
      );
    }
    lines.push('');
  }

  // Must reflect whether anything was ever stored, not whether the budget
  // truncation happened to keep zero entries this call — those are different
  // facts, and conflating them produces a header saying "N entries" directly
  // above a message claiming nothing has ever been saved.
  if (entries.length === 0) {
    lines.push('（这个项目还没有存过上下文。用 /kireo:save 存第一条。）');
  }

  return lines.join('\n').trimEnd();
};
