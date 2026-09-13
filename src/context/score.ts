import { type ContextBucket, bucketHalfLifeDays } from '@kireo/shared';

/** Relative weight per bucket at equal importance and age. */
const BUCKET_WEIGHT: Record<ContextBucket, number> = {
  constraint: 1.3,
  open: 1.2,
  decision: 1.0,
  gotcha: 0.9,
  map: 0.7,
  pref: 0.8,
};

export const scoreEntry = (
  e: { bucket: ContextBucket; importance: number; occurredAt: string },
  now: Date,
): number => {
  const half = bucketHalfLifeDays(e.bucket);
  let decay = 1;
  if (half !== null) {
    const t = Date.parse(e.occurredAt);
    // An unparseable timestamp is treated as "just now": dropping the entry
    // would be a silent data loss caused by a formatting bug.
    const ageDays = Number.isNaN(t) ? 0 : Math.max(0, (now.getTime() - t) / 86400_000);
    decay = 0.5 ** (ageDays / half);
  }
  return e.importance * decay * BUCKET_WEIGHT[e.bucket];
};
