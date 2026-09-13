import { z } from 'zod';
import type { MemoryType } from './memory-types.js';

export const CONTEXT_BUCKETS = [
  'decision',
  'constraint',
  'gotcha',
  'open',
  'map',
  'pref',
] as const;

export type ContextBucket = (typeof CONTEXT_BUCKETS)[number];

/**
 * Buckets ride on the existing MemoryType enum — no backend schema change.
 * See spec §8.4 for why adding a LanceDB column is off the table.
 */
const BUCKET_TYPE: Record<ContextBucket, MemoryType> = {
  decision: 'decision',
  constraint: 'fact',
  gotcha: 'insight',
  open: 'goal',
  map: 'fact',
  pref: 'preference',
};

export const bucketToMemoryType = (b: ContextBucket): MemoryType => BUCKET_TYPE[b];

/**
 * Half-life in days, or null for "does not decay".
 *
 * Constraints and preferences do not become less true with age. Open threads
 * do not either — they get a [stale] marker at render time instead, because a
 * forgotten TODO is still a TODO.
 */
const BUCKET_HALF_LIFE: Record<ContextBucket, number | null> = {
  decision: 60,
  constraint: null,
  gotcha: 45,
  open: null,
  map: 21,
  pref: null,
};

export const bucketHalfLifeDays = (b: ContextBucket): number | null => BUCKET_HALF_LIFE[b];

export const ContextEntrySchema = z
  .object({
    bucket: z.enum(CONTEXT_BUCKETS),
    // 60–400 is far below CONTENT_MAX(8000) on purpose: a constraint does not
    // get truer by being longer, and short cards keep the injected budget sane.
    content: z.string().trim().min(60).max(400),
    // Required and non-empty. This is the anti-hallucination guard pushed down
    // to the schema — a model that cannot cite a basis cannot write a card.
    evidence: z.string().trim().min(1),
    files: z.array(z.string()).max(10).default([]),
    importance: z.number().min(0).max(1).default(0.5),
    /** Ids of existing entries this one replaces. */
    supersedes: z.array(z.string()).max(20).default([]),
  })
  .strict();

export type ContextEntry = z.infer<typeof ContextEntrySchema>;

/**
 * Fixed four tags. TAG_MAX is 10, so this leaves room without ever tripping it.
 * All parts are lowercased and stripped to satisfy TAG_REGEX (/^[a-z0-9_-]+$/).
 */
export const contextTags = (
  bucket: ContextBucket,
  host: string,
  sessionId: string,
): string[] => {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-{2,}/g, '-');
  return [
    'kireo-ctx',
    `k-${bucket}`,
    `h-${clean(host).slice(0, 24)}`,
    `s-${clean(sessionId).slice(0, 8)}`,
  ];
};
