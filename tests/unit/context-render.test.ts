import { describe, expect, it } from 'vitest';

import { type RenderableEntry, renderContext } from '../../src/context/render.js';
import { scoreEntry } from '../../src/context/score.js';

const NOW = new Date('2026-08-30T00:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400_000).toISOString();

describe('scoreEntry', () => {
  it('does not decay constraints', () => {
    const fresh = scoreEntry(
      { bucket: 'constraint', importance: 0.5, occurredAt: daysAgo(0) },
      NOW,
    );
    const old = scoreEntry(
      { bucket: 'constraint', importance: 0.5, occurredAt: daysAgo(365) },
      NOW,
    );
    expect(old).toBeCloseTo(fresh, 5);
  });

  it('halves a decision at its 60-day half-life', () => {
    const fresh = scoreEntry({ bucket: 'decision', importance: 1, occurredAt: daysAgo(0) }, NOW);
    const aged = scoreEntry({ bucket: 'decision', importance: 1, occurredAt: daysAgo(60) }, NOW);
    expect(aged / fresh).toBeCloseTo(0.5, 2);
  });

  it('ranks importance monotonically within a bucket', () => {
    const lo = scoreEntry({ bucket: 'map', importance: 0.2, occurredAt: daysAgo(1) }, NOW);
    const hi = scoreEntry({ bucket: 'map', importance: 0.9, occurredAt: daysAgo(1) }, NOW);
    expect(hi).toBeGreaterThan(lo);
  });

  it('treats an unparseable timestamp as fresh rather than throwing', () => {
    expect(() =>
      scoreEntry({ bucket: 'map', importance: 0.5, occurredAt: 'garbage' }, NOW),
    ).not.toThrow();
  });
});

const entry = (over: Partial<Parameters<typeof renderContext>[0][number]> = {}) => ({
  id: 'm1',
  bucket: 'decision' as const,
  content: 'chose BullMQ over Redis Streams',
  occurredAt: daysAgo(3),
  importance: 0.8,
  host: 'claude-code',
  uncertain: false,
  ...over,
});

const meta = {
  projectKey: 'github.com/acme/widget',
  source: 'git remote',
  indexCommit: 'abc1234',
  indexAgeDays: 12,
};

describe('renderContext', () => {
  it('always prints the project key and its source on the first line', () => {
    const out = renderContext([entry()], meta, NOW);
    expect(out.split('\n')[0]).toContain('github.com/acme/widget');
    expect(out.split('\n')[0]).toContain('git remote');
  });

  it('always prints index freshness — the most misleading thing to omit', () => {
    // Without it the model assumes the code index is current.
    const out = renderContext([entry()], meta, NOW);
    expect(out).toContain('abc1234');
    expect(out).toMatch(/12d/);
  });

  it('says so explicitly when there is no code index at all', () => {
    const out = renderContext([entry()], { ...meta, indexCommit: null, indexAgeDays: null }, NOW);
    expect(out).toMatch(/no code index|未建立索引/i);
  });

  it('groups in the fixed order constraints → open → decisions → gotchas → map → prefs', () => {
    const out = renderContext(
      [
        entry({ id: 'a', bucket: 'pref', content: 'p'.repeat(20) }),
        entry({ id: 'b', bucket: 'constraint', content: 'c'.repeat(20) }),
        entry({ id: 'c', bucket: 'open', content: 'o'.repeat(20) }),
      ],
      meta,
      NOW,
    );
    expect(out.indexOf('c'.repeat(20))).toBeLessThan(out.indexOf('o'.repeat(20)));
    expect(out.indexOf('o'.repeat(20))).toBeLessThan(out.indexOf('p'.repeat(20)));
  });

  it('marks an open thread older than 90 days as stale', () => {
    const out = renderContext([entry({ bucket: 'open', occurredAt: daysAgo(120) })], meta, NOW);
    expect(out).toContain('[stale]');
  });

  it('marks low-confidence entries as uncertain', () => {
    const out = renderContext([entry({ uncertain: true })], meta, NOW);
    expect(out).toContain('[uncertain]');
  });

  it('shows age and host on each entry', () => {
    const out = renderContext([entry()], meta, NOW);
    expect(out).toMatch(/3d ago/);
    expect(out).toContain('claude-code');
  });

  it('truncates by score, keeping the highest-scoring entries, under budget', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      entry({ id: `m${i}`, importance: i / 200, content: `entry number ${i} `.repeat(4) }),
    );
    const out = renderContext(many, meta, NOW, 300);
    expect(out.length / 4).toBeLessThan(400);
    // The most important entry survives; the least important does not.
    expect(out).toContain('entry number 199');
    expect(out).not.toContain('entry number 0 ');
  });

  it('renders a usable message when there is nothing stored yet', () => {
    const out = renderContext([], meta, NOW);
    expect(out).toContain('github.com/acme/widget');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('renderContext budget truncation is visible (review finding)', () => {
  const entry = (over: Partial<RenderableEntry> = {}): RenderableEntry => ({
    id: Math.random().toString(36).slice(2),
    bucket: 'decision',
    content: 'x'.repeat(300),
    occurredAt: new Date().toISOString(),
    importance: 0.85,
    host: 'claude-code',
    uncertain: false,
    ...over,
  });

  const meta = {
    projectKey: 'github.com/acme/api',
    source: 'git',
    indexCommit: 'abc',
    indexAgeDays: 1,
  };

  /** 40 fresh high-importance decisions + one old, low-importance constraint. */
  const crowded = (): RenderableEntry[] => [
    ...Array.from({ length: 40 }, () => entry()),
    entry({
      bucket: 'constraint',
      importance: 0.4,
      content: '绝对不能改 LanceDB 表 schema',
      occurredAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
    }),
  ];

  it('reports "showing K of N", not N, when the budget cut entries', () => {
    // The header used to claim all 41 while rendering ~13 bullets, so the
    // model read a complete-looking context that was two thirds missing.
    const out = renderContext(crowded(), meta, new Date(), 1200);
    const bullets = out.split('\n').filter((l) => l.startsWith('- ')).length;
    expect(out).toMatch(/showing \d+ of 41 entries/);
    expect(bullets).toBeLessThan(41);
  });

  it('never lets a whole bucket vanish silently — the constraints case', () => {
    // A group whose every entry was cut lost its heading too, so "no
    // Constraints section" was indistinguishable from "this project has no
    // hard constraints". A model then does the thing the constraint forbade —
    // the mirror image of spec §14.2's "injecting a constraint that does not
    // exist is worse than no context".
    const out = renderContext(crowded(), meta, new Date(), 1200);
    expect(out).toContain('## Constraints');
    expect(out).toMatch(/另有 \d+ 条Constraints 因 token 预算未展示/);
  });

  it('says nothing about truncation when everything fits', () => {
    const out = renderContext([entry({ content: 'short' })], meta, new Date(), 1200);
    expect(out).toContain('1 entries');
    expect(out).not.toContain('showing');
    expect(out).not.toContain('未展示');
  });

  it('flags that the reader stopped paging before the list ran out', () => {
    const out = renderContext(
      [entry({ content: 'short' })],
      { ...meta, moreBeyondFetched: true },
      new Date(),
      1200,
    );
    expect(out).toContain('还有更多未读取');
  });
});
