import { RestApiError } from '../lib/errors.js';
import { sleep } from '../lib/sleep.js';

export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  capMs: number;
}

// `idempotent` says whether replaying the request is side-effect-free. For a
// non-idempotent request (e.g. POST /v1/memories — a create) we must NOT retry
// on any error where the server might already have applied it, or we duplicate
// the resource. We only retry such requests on errors that prove the server did
// not act: an explicit 429 / 503 (rejected before processing). Timeouts, dropped
// connections and other 5xx are ambiguous — the create may have committed — so
// they are retried only when the request is idempotent.
export function shouldRetry(err: unknown, idempotent = true): boolean {
  // 用户主动取消或 signal 已 abort，不重试
  if (err instanceof Error && err.name === 'AbortError') {
    return false;
  }
  if (err instanceof RestApiError) {
    // Explicit backpressure — the server rejected the request without acting on
    // it, so retrying is safe even for a non-idempotent write.
    if (err.httpStatus === 429 || err.httpStatus === 503) return true;
    // Other 5xx may have partially applied the request → idempotent only.
    if (err.httpStatus >= 500) return idempotent;
    return false;
  }
  if (err instanceof Error) {
    // Network/timeout: we cannot tell whether the server processed the request.
    if (/timeout|fetch failed|ECONN|EAI_AGAIN/i.test(err.message)) return idempotent;
    return false;
  }
  return false;
}

export function backoffDelay(attempt: number, policy: RetryPolicy, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(retryAfterMs, policy.capMs);
  }
  const exp = Math.min(policy.baseMs * 2 ** attempt, policy.capMs);
  const jitter = Math.random() * 0.3 * exp;
  return Math.min(exp + jitter, policy.capMs);
}

export async function withRetry<T>(
  policy: RetryPolicy,
  fn: (attempt: number) => Promise<T>,
  signal?: AbortSignal,
  idempotent = true,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === policy.maxAttempts || !shouldRetry(err, idempotent)) throw err;
      const retryAfterMs = err instanceof RestApiError ? err.retryAfterMs : undefined;
      const delay = backoffDelay(attempt, policy, retryAfterMs);
      await sleep(delay, signal);
    }
  }
  throw lastErr;
}
