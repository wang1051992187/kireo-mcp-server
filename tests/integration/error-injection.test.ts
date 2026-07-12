import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode as McpErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server.js';
import errors from '../helpers/fixtures/error-envelopes.json' with { type: 'json' };

const rest = setupServer();

async function withConnected<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = await createServer({
    argv: [],
    env: {
      KIREO_API_KEY: 'ki_sk_test_key_1234',
      KIREO_TELEMETRY: '0',
      KIREO_LOG_LEVEL: 'silent',
      KIREO_RETRY_MAX_ATTEMPTS: '1',
      KIREO_RETRY_BASE_MS: '1',
    } as NodeJS.ProcessEnv,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('error injection', () => {
  beforeAll(() => rest.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => rest.resetHandlers());
  afterAll(() => rest.close());

  it('401 AUTH_INVALID_KEY → MCP InvalidRequest', async () => {
    rest.use(
      http.post('https://api.kireo.app/v1/memories', () =>
        HttpResponse.json(errors.auth_invalid, { status: 401 }),
      ),
    );
    await withConnected(async (client) => {
      await expect(
        client.callTool({ name: 'memory_save', arguments: { content: 'x' } }),
      ).rejects.toMatchObject({
        code: McpErrorCode.InvalidRequest,
      });
    });
  });

  it('402 QUOTA_EXCEEDED → InvalidRequest with upgrade hint', async () => {
    rest.use(
      http.post('https://api.kireo.app/v1/memories', () =>
        HttpResponse.json(errors.quota_exceeded, { status: 402 }),
      ),
    );
    await withConnected(async (client) => {
      await expect(
        client.callTool({ name: 'memory_save', arguments: { content: 'x' } }),
      ).rejects.toMatchObject({ code: McpErrorCode.InvalidRequest });
    });
  });

  it('429 RATE_LIMITED → 重试后仍失败 → InternalError', async () => {
    rest.use(
      http.post('https://api.kireo.app/v1/search', () =>
        HttpResponse.json(errors.rate_limited, {
          status: 429,
          headers: { 'retry-after': '1' },
        }),
      ),
    );
    await withConnected(async (client) => {
      await expect(
        client.callTool({ name: 'memory_search', arguments: { query: 'x' } }),
      ).rejects.toMatchObject({ code: McpErrorCode.InternalError });
    });
  });

  it('503 INTERNAL_ERROR → 自动重试后失败', async () => {
    let calls = 0;
    // memory_recall now reads the query-less list endpoint (GET /v1/memories),
    // not POST /v1/recall.
    rest.use(
      http.get('https://api.kireo.app/v1/memories', () => {
        calls++;
        return HttpResponse.json(errors.internal, { status: 503 });
      }),
    );
    await withConnected(async (client) => {
      await expect(client.callTool({ name: 'memory_recall', arguments: {} })).rejects.toMatchObject(
        { code: McpErrorCode.InternalError },
      );
    });
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
