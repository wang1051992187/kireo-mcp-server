import { McpError, ErrorCode as McpErrorCode } from '@modelcontextprotocol/sdk/types.js';

// ─── Error Code ──────────────────────────────────────────────────────────────
//
// The wire codes are owned by the API (@kireo/shared ErrorCode, e.g.
// VALIDATION_FAILED / NOT_FOUND / INTERNAL). The parser passes those through
// verbatim, so this type is a plain string — never re-invent or downgrade a
// real code to a local synonym. `KnownRestErrorCode` lists the ones we render
// a tailored hint for; any other code falls through to detail/message.

export type KnownRestErrorCode =
  | 'VALIDATION_FAILED'
  | 'AUTH_INVALID_KEY'
  | 'AUTH_TOKEN_EXPIRED'
  | 'AUTH_TOKEN_INVALID'
  | 'AUTH_MISSING'
  | 'AUTH_SCOPE_INSUFFICIENT'
  | 'USER_BANNED'
  | 'QUOTA_EXCEEDED'
  | 'QUOTA_PLAN_DOWNGRADED'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'MEMORY_COUNT_EXCEEDED'
  | 'NAMESPACE_QUOTA_EXCEEDED'
  | 'NOT_FOUND'
  | 'MEMORY_NOT_FOUND'
  | 'NAMESPACE_NOT_FOUND'
  | 'TASK_NOT_FOUND'
  | 'ASYNC_TASK_NOT_FOUND'
  | 'CONFLICT'
  | 'NAMESPACE_NOT_EMPTY'
  | 'NAMESPACE_ALREADY_EXISTS'
  | 'RATE_LIMITED'
  | 'CONTENT_TOO_LARGE'
  | 'BATCH_TOO_LARGE'
  | 'EMBEDDING_UNAVAILABLE'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL'
  | 'UNKNOWN';

// Allow any wire string while preserving autocomplete for the known set.
export type RestErrorCode = KnownRestErrorCode | (string & {});

// ─── RestApiError ─────────────────────────────────────────────────────────────

export interface RestErrorPayload {
  code: RestErrorCode;
  message: string;
  detail?: string;
  retryAfterMs?: number;
  requestId?: string;
}

export class RestApiError extends Error {
  readonly code: RestErrorCode;
  readonly detail?: string;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly httpStatus: number;

  constructor(payload: RestErrorPayload, httpStatus: number) {
    super(payload.message);
    this.name = 'RestApiError';
    this.code = payload.code;
    this.httpStatus = httpStatus;
    if (payload.detail !== undefined) this.detail = payload.detail;
    if (payload.retryAfterMs !== undefined) this.retryAfterMs = payload.retryAfterMs;
    if (payload.requestId !== undefined) this.requestId = payload.requestId;
  }
}

// ─── Hint renderer ────────────────────────────────────────────────────────────

function renderHint(payload: RestErrorPayload): string {
  switch (payload.code) {
    case 'QUOTA_EXCEEDED':
    case 'STORAGE_QUOTA_EXCEEDED':
    case 'MEMORY_COUNT_EXCEEDED':
    case 'NAMESPACE_QUOTA_EXCEEDED':
    case 'QUOTA_PLAN_DOWNGRADED':
      return 'Quota exceeded. Delete old memories or upgrade your plan.';
    case 'AUTH_INVALID_KEY':
    case 'AUTH_TOKEN_INVALID':
    case 'AUTH_TOKEN_EXPIRED':
      return 'API key is invalid, expired, or revoked. Run `kireo-mcp --api-key <new-key>` to update.';
    case 'AUTH_MISSING':
      return 'No API key was sent. Configure your Kireo API key in the MCP client.';
    case 'AUTH_SCOPE_INSUFFICIENT':
      return 'Your API key lacks the required scope. Issue a new key with the correct permissions.';
    case 'USER_BANNED':
      return 'This account is suspended. Contact support.';
    case 'RATE_LIMITED': {
      const wait = payload.retryAfterMs != null ? ` Retry after ${payload.retryAfterMs}ms.` : '';
      return `Rate limit reached.${wait}`;
    }
    case 'CONTENT_TOO_LARGE':
    case 'BATCH_TOO_LARGE':
      return 'Payload exceeds the maximum allowed size. Split into smaller chunks before storing.';
    case 'NOT_FOUND':
    case 'TASK_NOT_FOUND':
    case 'ASYNC_TASK_NOT_FOUND':
      return 'Resource not found. It may have been deleted or the ID is incorrect.';
    case 'NAMESPACE_NOT_FOUND':
      return 'Namespace does not exist. Create it first or check the namespace name.';
    case 'NAMESPACE_NOT_EMPTY':
      return 'Namespace is not empty. Delete its memories first or use cascade.';
    case 'NAMESPACE_ALREADY_EXISTS':
      return 'A namespace with that name already exists.';
    case 'MEMORY_NOT_FOUND':
      return 'Memory entry not found. It may have been deleted or the ID is incorrect.';
    case 'CONFLICT':
      return 'Conflicting update. Fetch the latest version and retry.';
    case 'VALIDATION_FAILED':
      return `Validation failed: ${payload.detail ?? payload.message}`;
    case 'EMBEDDING_UNAVAILABLE':
      return 'Embedding service is temporarily unavailable — the memory was saved and will be embedded shortly. Retry searches later.';
    case 'SERVICE_UNAVAILABLE':
      return 'Service is temporarily unavailable. Check https://status.kireo.app and retry later.';
    case 'INTERNAL':
      return `Internal server error. ${payload.requestId ? `Reference request id ${payload.requestId} when contacting support.` : 'Retry shortly.'}`;
    default:
      return payload.detail ?? payload.message;
  }
}

// ─── MCP Error Mapping ────────────────────────────────────────────────────────

const HTTP_TO_MCP: Record<number, number> = {
  400: McpErrorCode.InvalidParams,
  401: McpErrorCode.InvalidRequest,
  403: McpErrorCode.InvalidRequest,
  404: McpErrorCode.InvalidRequest,
  409: McpErrorCode.InvalidRequest,
  402: McpErrorCode.InvalidRequest,
  413: McpErrorCode.InvalidParams,
  422: McpErrorCode.InvalidParams,
  429: McpErrorCode.InternalError,
  500: McpErrorCode.InternalError,
  502: McpErrorCode.InternalError,
  503: McpErrorCode.InternalError,
  504: McpErrorCode.InternalError,
};

const CODE_TO_MCP: Record<string, number> = {
  AUTH_INVALID_KEY: McpErrorCode.InvalidRequest,
  AUTH_TOKEN_INVALID: McpErrorCode.InvalidRequest,
  AUTH_TOKEN_EXPIRED: McpErrorCode.InvalidRequest,
  AUTH_MISSING: McpErrorCode.InvalidRequest,
  AUTH_SCOPE_INSUFFICIENT: McpErrorCode.InvalidRequest,
  USER_BANNED: McpErrorCode.InvalidRequest,
  QUOTA_EXCEEDED: McpErrorCode.InvalidRequest,
  STORAGE_QUOTA_EXCEEDED: McpErrorCode.InvalidRequest,
  MEMORY_COUNT_EXCEEDED: McpErrorCode.InvalidRequest,
  VALIDATION_FAILED: McpErrorCode.InvalidParams,
  NOT_FOUND: McpErrorCode.InvalidRequest,
  NAMESPACE_NOT_FOUND: McpErrorCode.InvalidRequest,
  MEMORY_NOT_FOUND: McpErrorCode.InvalidRequest,
  CONFLICT: McpErrorCode.InvalidRequest,
  CONTENT_TOO_LARGE: McpErrorCode.InvalidParams,
  BATCH_TOO_LARGE: McpErrorCode.InvalidParams,
};

export function toMcpError(err: RestApiError): McpError {
  const mcpCode =
    CODE_TO_MCP[err.code] ?? HTTP_TO_MCP[err.httpStatus] ?? McpErrorCode.InternalError;

  const hintPayload: RestErrorPayload = { code: err.code, message: err.message };
  if (err.detail !== undefined) hintPayload.detail = err.detail;
  if (err.retryAfterMs !== undefined) hintPayload.retryAfterMs = err.retryAfterMs;
  if (err.requestId !== undefined) hintPayload.requestId = err.requestId;
  const hint = renderHint(hintPayload);

  const data = {
    restCode: err.code,
    httpStatus: err.httpStatus,
    hint,
    requestId: err.requestId ?? 'n/a',
  };

  return new McpError(mcpCode, err.message, data);
}
