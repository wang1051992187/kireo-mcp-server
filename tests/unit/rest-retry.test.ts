import { describe, expect, it } from 'vitest';
import { RestApiError } from '../../src/lib/errors.js';
import { backoffDelay, shouldRetry, withRetry } from '../../src/rest/retry.js';

describe('shouldRetry', () => {
  it('5xx retry', () => {
    expect(shouldRetry(new RestApiError({ code: 'UPSTREAM_UNAVAILABLE', message: 'x' }, 503))).toBe(
      true,
    );
  });
  it('429 retry', () => {
    expect(shouldRetry(new RestApiError({ code: 'RATE_LIMITED', message: 'x' }, 429))).toBe(true);
  });
  it('400 no retry', () => {
    expect(shouldRetry(new RestApiError({ code: 'VALIDATION_ERROR', message: 'x' }, 400))).toBe(
      false,
    );
  });
  it('network error retry', () => {
    expect(shouldRetry(new Error('fetch failed'))).toBe(true);
  });
  it('AbortError 不重试', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(shouldRetry(err)).toBe(false);
  });

  describe('idempotency-aware (non-idempotent writes must not duplicate)', () => {
    const timeout = new Error('request timeout after 1000ms');
    const network = new Error('fetch failed');
    const err500 = new RestApiError({ code: 'INTERNAL', message: 'x' }, 500);
    const err503 = new RestApiError({ code: 'UPSTREAM_UNAVAILABLE', message: 'x' }, 503);
    const err429 = new RestApiError({ code: 'RATE_LIMITED', message: 'x' }, 429);

    it('non-idempotent: does NOT retry on timeout / network / 5xx (server may have applied it)', () => {
      expect(shouldRetry(timeout, false)).toBe(false);
      expect(shouldRetry(network, false)).toBe(false);
      expect(shouldRetry(err500, false)).toBe(false);
    });

    it('non-idempotent: DOES retry on explicit 429 / 503 (server rejected before acting)', () => {
      expect(shouldRetry(err429, false)).toBe(true);
      expect(shouldRetry(err503, false)).toBe(true);
    });

    it('idempotent (default): retries timeout / network / 5xx as before', () => {
      expect(shouldRetry(timeout, true)).toBe(true);
      expect(shouldRetry(network, true)).toBe(true);
      expect(shouldRetry(err500, true)).toBe(true);
      expect(shouldRetry(timeout)).toBe(true);
    });
  });

  it('withRetry threads idempotent=false → a timing-out create is attempted exactly once', async () => {
    let calls = 0;
    await expect(
      withRetry(
        { maxAttempts: 3, baseMs: 1, capMs: 5 },
        async () => {
          calls++;
          throw new Error('request timeout after 1000ms');
        },
        undefined,
        false,
      ),
    ).rejects.toThrow(/timeout/);
    expect(calls).toBe(1);
  });
});

describe('backoffDelay', () => {
  it('Retry-After 优先', () => {
    const d = backoffDelay(0, { maxAttempts: 3, baseMs: 200, capMs: 5000 }, 2000);
    expect(d).toBe(2000);
  });
  it('指数 + jitter 不超过 cap', () => {
    const d = backoffDelay(10, { maxAttempts: 3, baseMs: 200, capMs: 1000 });
    expect(d).toBeLessThanOrEqual(1300);
  });
});

describe('withRetry', () => {
  it('在第二次成功后返回', async () => {
    let calls = 0;
    const r = await withRetry({ maxAttempts: 3, baseMs: 1, capMs: 5 }, async () => {
      calls++;
      if (calls < 2) throw new RestApiError({ code: 'INTERNAL_ERROR', message: 'x' }, 500);
      return 'ok';
    });
    expect(r).toBe('ok');
    expect(calls).toBe(2);
  });

  it('达到 maxAttempts 后抛出最后错误', async () => {
    await expect(
      withRetry({ maxAttempts: 2, baseMs: 1, capMs: 5 }, async () => {
        throw new RestApiError({ code: 'INTERNAL_ERROR', message: 'down' }, 500);
      }),
    ).rejects.toBeInstanceOf(RestApiError);
  });
});
