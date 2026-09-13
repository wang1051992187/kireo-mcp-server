export type Plan = 'free' | 'pro';

export interface PlanLimits {
  writes: number; // monthly write quota
  reads: number; // monthly read quota
  storageBytes: number; // max total storage bytes
  memories: number; // max memory rows
  namespaces: number; // max namespaces
  apiKeys: number; // max api keys
  retentionDays: number; // Free: 30-day TTL; Pro: no TTL
}

// W1 stub — Plan 6 (billing) 实施时可能扩展更多字段。
// 与 apps/api/src/middleware/quota.ts 的 PLAN_QUOTAS 保持一致的 writes/reads/storageBytes，
// 并新增 memories/namespaces/apiKeys/retentionDays。
export const PLAN_CONFIG: Record<Plan, PlanLimits> = {
  free: {
    writes: 100,
    reads: 200,
    storageBytes: 5 * 1024 * 1024,
    memories: 200,
    namespaces: 3,
    apiKeys: 2,
    retentionDays: 30,
  },
  pro: {
    writes: 5_000,
    reads: 20_000,
    storageBytes: 200 * 1024 * 1024,
    memories: 50_000,
    // 20 only fit (20-1)/2 = 9 projects (ctx+code buckets, -1 for kireo-home).
    // A power user with 15 repos would hit the wall; 64 covers >=31 projects.
    namespaces: 64,
    apiKeys: 10,
    retentionDays: 0, // 0 表示不过期
  },
};

/**
 * Map any stored plan string to an app-level Plan. Legacy `max` subscribers
 * coalesce to `pro`; unknown values fall back to `free` (fail-closed).
 */
export function normalizePlan(value: string): Plan {
  return value === 'pro' || value === 'max' ? 'pro' : 'free';
}
