import { McpError, ErrorCode as McpErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { RestApiError, toMcpError } from '../../src/lib/errors.js';
import { parseRestError } from '../../src/rest/errors.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeRes(
  status: number,
  body: unknown,
  opts: { contentType?: string; retryAfter?: string } = {},
): Response {
  const contentType = opts.contentType ?? 'application/json';
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': contentType };
  if (opts.retryAfter != null) headers['retry-after'] = opts.retryAfter;
  return new Response(bodyStr, { status, headers });
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('parseRestError', () => {
  it('parses well-formed envelope into RestApiError', async () => {
    const res = makeRes(429, {
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
    });
    const err = await parseRestError(res, 'req-123');
    expect(err).toBeInstanceOf(RestApiError);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.httpStatus).toBe(429);
    expect(err.requestId).toBe('req-123');
    expect(err.message).toBe('Too many requests');
  });

  it('parses the API envelope when success is omitted', async () => {
    const res = makeRes(402, {
      error: { code: 'QUOTA_EXCEEDED', message: 'monthly quota reached' },
    });
    const err = await parseRestError(res);
    expect(err.code).toBe('QUOTA_EXCEEDED');
    expect(err.message).toBe('monthly quota reached');
  });

  it('extracts Retry-After seconds header into retryAfterMs', async () => {
    const res = makeRes(
      429,
      { success: false, error: { code: 'RATE_LIMITED', message: 'slow down' } },
      { retryAfter: '30' },
    );
    const err = await parseRestError(res);
    expect(err.retryAfterMs).toBe(30_000);
  });

  it('falls back to httpStatusToCode on non-envelope JSON', async () => {
    const res = makeRes(401, { msg: 'go away' });
    const err = await parseRestError(res);
    expect(err.code).toBe('AUTH_INVALID_KEY');
    expect(err.httpStatus).toBe(401);
  });

  it('handles plain text body fallback', async () => {
    const res = makeRes(503, 'Service Unavailable', { contentType: 'text/plain' });
    const err = await parseRestError(res);
    expect(err.code).toBe('SERVICE_UNAVAILABLE');
    expect(err.message).toBe('Service Unavailable');
  });

  it('passes the real wire code through instead of downgrading to UNKNOWN', async () => {
    // The API sends @kireo/shared codes; older clients mangled anything not in
    // a hand-rolled set into UNKNOWN, hiding VALIDATION_FAILED/NOT_FOUND/INTERNAL.
    for (const [status, code] of [
      [400, 'VALIDATION_FAILED'],
      [404, 'NOT_FOUND'],
      [500, 'INTERNAL'],
      [402, 'QUOTA_EXCEEDED'],
    ] as const) {
      const res = makeRes(status, { error: { code, message: 'm', request_id: 'r' } });
      const err = await parseRestError(res);
      expect(err.code).toBe(code);
    }
  });

  it('flattens the API details object into detail', async () => {
    const res = makeRes(400, {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'invalid request body',
        request_id: 'r2',
        details: { issues: [{ path: ['name'], message: 'Required' }] },
      },
    });
    const err = await parseRestError(res);
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.detail).toContain('Required');
  });
});

describe('toMcpError', () => {
  it('maps AUTH_INVALID_KEY to McpErrorCode.InvalidRequest', () => {
    const rest = new RestApiError(
      { code: 'AUTH_INVALID_KEY', message: 'bad key', requestId: 'r1' },
      401,
    );
    const mcp = toMcpError(rest);
    expect(mcp).toBeInstanceOf(McpError);
    expect(mcp.code).toBe(McpErrorCode.InvalidRequest);
    const data = mcp.data as Record<string, unknown>;
    expect(data.restCode).toBe('AUTH_INVALID_KEY');
    expect(data.requestId).toBe('r1');
    expect(typeof data.hint).toBe('string');
  });

  it('uses n/a as requestId fallback when not provided', () => {
    const rest = new RestApiError({ code: 'INTERNAL', message: 'boom' }, 500);
    const mcp = toMcpError(rest);
    const data = mcp.data as Record<string, unknown>;
    expect(data.requestId).toBe('n/a');
    expect(mcp.code).toBe(McpErrorCode.InternalError);
  });
});
