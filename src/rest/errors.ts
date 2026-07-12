import { RestApiError, type RestErrorCode, type RestErrorPayload } from '../lib/errors.js';

// ─── API envelope shape ───────────────────────────────────────────────────────

interface ApiEnvelope {
  success?: false;
  error: {
    code: string;
    message: string;
    // The API sends a structured `details` object (e.g. Zod {issues:[...]});
    // older clients also accept a flat `detail` string. Read both.
    details?: unknown;
    detail?: string;
    request_id?: string;
  };
}

function isApiEnvelope(value: unknown): value is ApiEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.success !== undefined && v.success !== false) return false;
  if (typeof v.error !== 'object' || v.error === null) return false;
  const e = v.error as Record<string, unknown>;
  return typeof e.code === 'string' && typeof e.message === 'string';
}

// Trust the wire code verbatim — it is owned by the API (@kireo/shared
// ErrorCode). Downgrading unknown codes to 'UNKNOWN' (the old behaviour) hid
// the real code (VALIDATION_FAILED, NOT_FOUND, INTERNAL, …) from MCP clients.
function toRestErrorCode(raw: string): RestErrorCode {
  return raw.trim() ? raw : 'UNKNOWN';
}

// Flatten the API's `details` object/string into the single `detail` string
// the rest of the client renders.
function extractDetail(err: { detail?: string; details?: unknown }): string | undefined {
  if (typeof err.detail === 'string') return err.detail;
  if (err.details === undefined || err.details === null) return undefined;
  if (typeof err.details === 'string') return err.details;
  try {
    return JSON.stringify(err.details);
  } catch {
    return undefined;
  }
}

// ─── Retry-After header helpers ───────────────────────────────────────────────

function parseRetryAfterMs(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  if (header == null) return undefined;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const diff = date - Date.now();
    return diff > 0 ? diff : undefined;
  }
  return undefined;
}

// ─── Main parser ──────────────────────────────────────────────────────────────

export async function parseRestError(res: Response, requestId?: string): Promise<RestApiError> {
  const retryAfterMs = parseRetryAfterMs(res);

  let payload: RestErrorPayload;

  const contentType = res.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (isApiEnvelope(body)) {
      const err = body.error;
      const resolvedRequestId = requestId ?? err.request_id;
      payload = { code: toRestErrorCode(err.code), message: err.message };
      const detail = extractDetail(err);
      if (detail !== undefined) payload.detail = detail;
      if (retryAfterMs !== undefined) payload.retryAfterMs = retryAfterMs;
      if (resolvedRequestId !== undefined) payload.requestId = resolvedRequestId;
    } else {
      // JSON but not our envelope — synthesise from HTTP status
      payload = { code: httpStatusToCode(res.status), message: `HTTP ${res.status}` };
      if (retryAfterMs !== undefined) payload.retryAfterMs = retryAfterMs;
      if (requestId !== undefined) payload.requestId = requestId;
    }
  } else {
    // text / binary fallback
    let text = '';
    try {
      text = await res.text();
    } catch {
      // ignore
    }
    payload = {
      code: httpStatusToCode(res.status),
      message: text.slice(0, 200) || `HTTP ${res.status}`,
    };
    if (retryAfterMs !== undefined) payload.retryAfterMs = retryAfterMs;
    if (requestId !== undefined) payload.requestId = requestId;
  }

  return new RestApiError(payload, res.status);
}

// Only reached when the response is NOT our JSON envelope (proxy 502 HTML,
// opaque gateway errors). Synthesise the closest @kireo/shared code.
function httpStatusToCode(status: number): RestErrorCode {
  switch (status) {
    case 401:
      return 'AUTH_INVALID_KEY';
    case 403:
      return 'AUTH_SCOPE_INSUFFICIENT';
    case 402:
      return 'QUOTA_EXCEEDED';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
    case 422:
      return 'CONTENT_TOO_LARGE';
    case 400:
      return 'VALIDATION_FAILED';
    case 429:
      return 'RATE_LIMITED';
    case 503:
    case 502:
      return 'SERVICE_UNAVAILABLE';
    case 504:
      return 'SERVICE_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL' : 'UNKNOWN';
  }
}
