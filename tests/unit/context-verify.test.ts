import { describe, expect, it } from 'vitest';

import { verifyEvidence } from '../../src/context/verify.js';

const turns = [
  { role: 'user' as const, text: 'look at apps/api/src/lance/client.ts' },
  { role: 'assistant' as const, text: 'ran `pnpm test:unit`, ensureVectorIndex has no callers' },
];

describe('verifyEvidence', () => {
  it('accepts an entry citing a path that appeared in the session', () => {
    const [ok] = verifyEvidence(
      [{ evidence: 'apps/api/src/lance/client.ts:31', files: [] }],
      turns,
    );
    expect(ok).toBe(true);
  });

  it('accepts an entry citing a command that appeared in the session', () => {
    const [ok] = verifyEvidence([{ evidence: 'pnpm test:unit 全绿', files: [] }], turns);
    expect(ok).toBe(true);
  });

  it('rejects an entry citing a file the session never touched', () => {
    const [ok] = verifyEvidence(
      [{ evidence: 'src/totally/made/up.ts:99 说的', files: ['src/totally/made/up.ts'] }],
      turns,
    );
    expect(ok).toBe(false);
  });

  it('accepts everything when there is no transcript to check against', () => {
    // Degrade open, never block: an unavailable transcript must not silently
    // downgrade every entry the model produced.
    const [ok] = verifyEvidence([{ evidence: 'anything at all', files: [] }], []);
    expect(ok).toBe(true);
  });

  it('accepts prose evidence with no path or command tokens', () => {
    const [ok] = verifyEvidence([{ evidence: '用户明确说不要用 Material UI', files: [] }], turns);
    expect(ok).toBe(true);
  });
});
