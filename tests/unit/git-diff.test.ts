import { describe, expect, it, vi } from 'vitest';

import { diffSince } from '../../src/index/git-diff.js';

/** `git diff -z --name-status` output: NUL-separated fields, NUL-terminated. */
const z = (...fields: string[]): string => `${fields.join('\0')}\0`;

describe('diffSince', () => {
  it('splits git diff status letters into changed and deleted', () => {
    const exec = vi.fn(() =>
      z('M', 'src/a.ts', 'A', 'src/b.ts', 'D', 'src/gone.ts', 'R100', 'src/old.ts', 'src/new.ts'),
    );
    const out = diffSince('/repo', 'abc1234', exec);
    expect(out?.changed).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts', 'src/new.ts']));
    // A rename removes the old path as surely as a delete does.
    expect(out?.deleted).toEqual(expect.arrayContaining(['src/gone.ts', 'src/old.ts']));
  });

  it('asks git for RAW paths — quoted octal escapes silently skip the file', () => {
    // With core.quotePath at its default and no -z, git renders `普通.py` as
    // `"\346\231\256\351\200\232.py"`. run-index then looks that string up in
    // bufByPath, misses, and drops the file with no warning at all (its
    // extension parses as `.py"`, so configForExtension returns null before
    // extractFileDTOs' catch is ever reached) — while `filesChanged` still
    // counts it. The same garbage path goes into the prune DELETE, so a
    // deleted non-ASCII file's stale symbols can never be cleared either.
    const seen: string[][] = [];
    const exec = vi.fn((args: string[]) => {
      seen.push(args);
      return z('M', '普通.py');
    });
    const out = diffSince('/repo', 'abc', exec);
    expect(out?.changed).toEqual(['普通.py']);
    expect(seen[0]).toContain('-z');
    expect(seen[0]).toContain('core.quotePath=false');
  });

  it('handles paths containing spaces and tabs', () => {
    // -z removes the TAB delimiter entirely, so a tab inside a filename is no
    // longer indistinguishable from the field separator.
    const exec = vi.fn(() => z('M', 'has space.py', 'A', 'has\ttab.py'));
    expect(diffSince('/repo', 'abc', exec)?.changed).toEqual(['has space.py', 'has\ttab.py']);
  });

  it('returns null when git fails, so the caller falls back to a full scan', () => {
    const exec = vi.fn(() => {
      throw new Error('bad revision');
    });
    expect(diffSince('/repo', 'deadbeef', exec)).toBeNull();
  });

  it('emits POSIX paths even when git reports backslashes', () => {
    const exec = vi.fn(() => z('M', 'src\\win\\a.ts'));
    expect(diffSince('/repo', 'abc', exec)?.changed).toEqual(['src/win/a.ts']);
  });

  it('handles an empty diff', () => {
    expect(
      diffSince(
        '/repo',
        'abc',
        vi.fn(() => ''),
      ),
    ).toEqual({ changed: [], deleted: [] });
  });
});
