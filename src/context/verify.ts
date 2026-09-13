import type { TranscriptTurn } from './transcript.js';

/** Tokens that look like a file path or a shell command — things we can match literally. */
const CITEABLE =
  /(?:[\w.-]+\/)+[\w.-]+|`[^`]+`|\b(?:pnpm|npm|git|docker|curl|pytest|vitest)\s+[\w:-]+/g;

/**
 * Literal evidence check.
 *
 * Deliberately narrow: it verifies that file paths and commands cited by the
 * model actually appeared in the session, which catches "the model invented a
 * file it never opened". It does NOT verify semantics — an entry that turns a
 * discussed option into a settled decision can cite a real file and pass. That
 * class of error is addressed by the distillation prompt and the eval set, not
 * here (see spec §14.2 ①).
 *
 * Returns one boolean per entry, positionally aligned. Degrades OPEN: with no
 * transcript, everything passes rather than everything being downgraded.
 */
export const verifyEvidence = (
  entries: { evidence: string; files: string[] }[],
  turns: TranscriptTurn[],
): boolean[] => {
  if (turns.length === 0) return entries.map(() => true);
  const haystack = turns
    .map((t) => t.text)
    .join('\n')
    .toLowerCase();

  return entries.map((e) => {
    const cited = new Set<string>();
    for (const m of e.evidence.matchAll(CITEABLE)) {
      cited.add(m[0].replace(/`/g, '').trim().toLowerCase());
    }
    for (const f of e.files) cited.add(f.toLowerCase());

    // Prose-only evidence has nothing literal to check — not a failure.
    if (cited.size === 0) return true;

    for (const token of cited) {
      // Strip a trailing :line so `client.ts:31` matches `client.ts`.
      const bare = token.replace(/:\d+(?::\d+)?$/, '');
      if (bare && haystack.includes(bare)) return true;
    }
    return false;
  });
};
