import type { Logger } from 'pino';
import { type Dispatcher, ProxyAgent, fetch as undiciFetch } from 'undici';
import type { RuntimeConfig } from '../config/schema.js';
import { newRequestId } from '../lib/request-id.js';
import { parseRestError } from './errors.js';
import { type HeaderCtx, buildHeaders } from './headers.js';
import { type RetryPolicy, withRetry } from './retry.js';

export interface RestClient {
  request<T>(input: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    signal?: AbortSignal;
    // Whether replaying this request is side-effect-free. Defaults to
    // `method !== 'POST'` (GET/PATCH/DELETE are idempotent). A safe POST that
    // creates nothing (e.g. /v1/search) should pass `idempotent: true` so it
    // keeps retrying transient failures; a creating POST must leave it false so
    // a timeout retry cannot duplicate the resource.
    idempotent?: boolean;
  }): Promise<T>;
}

export interface RestClientDeps {
  config: RuntimeConfig;
  deviceId: string;
  version: string;
  logger: Logger;
}

export function createRestClient(deps: RestClientDeps): RestClient {
  const policy: RetryPolicy = {
    maxAttempts: deps.config.retryMaxAttempts,
    baseMs: deps.config.retryBaseMs,
    capMs: 5_000,
  };

  const dispatcher: Dispatcher | undefined = deps.config.proxyUrl
    ? new ProxyAgent(deps.config.proxyUrl)
    : undefined;

  return {
    async request<T>(opts: {
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      path: string;
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      signal?: AbortSignal;
      idempotent?: boolean;
    }): Promise<T> {
      const idempotent = opts.idempotent ?? opts.method !== 'POST';
      const requestId = newRequestId();
      const url = buildUrl(deps.config.apiUrl, opts.path, opts.query);
      const headerCtx: HeaderCtx = {
        config: deps.config,
        deviceId: deps.deviceId,
        requestId,
        version: deps.version,
      };
      const headers = buildHeaders(headerCtx);
      const log = deps.logger.child({ request_id: requestId, path: opts.path });

      return withRetry(
        policy,
        async (attempt) => {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), deps.config.requestTimeoutMs);
          const combinedSignal = opts.signal
            ? AbortSignal.any([opts.signal, ctl.signal])
            : ctl.signal;
          const t0 = Date.now();
          try {
            log.debug({ attempt, method: opts.method }, 'rest.request.start');
            const fetchOpts: Parameters<typeof undiciFetch>[1] & { dispatcher?: Dispatcher } = {
              method: opts.method,
              headers,
              signal: combinedSignal as AbortSignal,
              ...(opts.body != null ? { body: JSON.stringify(opts.body) } : {}),
              ...(dispatcher !== undefined ? { dispatcher } : {}),
            };
            const res = await undiciFetch(url, fetchOpts);
            if (!res.ok) {
              const err = await parseRestError(res as unknown as Response, requestId);
              log.warn(
                { attempt, status: res.status, code: err.code, elapsed: Date.now() - t0 },
                'rest.request.error',
              );
              throw err;
            }
            const ct = res.headers.get('content-type') ?? '';
            const body = ct.includes('application/json') ? ((await res.json()) as T) : ({} as T);
            log.debug({ attempt, status: res.status, elapsed: Date.now() - t0 }, 'rest.request.ok');
            return body;
          } catch (err) {
            if (
              err instanceof Error &&
              err.name === 'AbortError' &&
              ctl.signal.aborted &&
              !opts.signal?.aborted
            ) {
              const timeout = new Error(`request timeout after ${deps.config.requestTimeoutMs}ms`);
              timeout.name = 'TimeoutError';
              throw timeout;
            }
            throw err;
          } finally {
            clearTimeout(timer);
          }
        },
        opts.signal,
        idempotent,
      );
    },
  };
}

function buildUrl(
  base: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  if (/^[a-z]+:\/\//i.test(path)) {
    throw new Error(`absolute url not allowed in REST client path: ${path}`);
  }
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const normalizedPath = path.replace(/^\/+/, '');
  const u = new URL(normalizedPath, normalizedBase);
  if (query !== undefined) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      u.searchParams.append(k, String(v));
    }
  }
  return u.toString();
}
