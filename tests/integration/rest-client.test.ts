import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../../src/config/schema.js';
import { createRestClient } from '../../src/rest/client.js';
import { makeFailingMock, makeFlakyMock, makeRestMock } from '../helpers/make-rest-mock.js';

const logger = pino({ level: 'silent' });

function cfg(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    apiKey: 'ki_sk_test_key_1234',
    apiUrl: 'https://api.kireo.example',
    requestTimeoutMs: 2_000,
    retryMaxAttempts: 3,
    retryBaseMs: 5,
    telemetryEnabled: true,
    logLevel: 'silent',
    defaultNamespace: 'default',
    acceptLanguage: 'en',
    ...overrides,
  };
}

describe('RestClient happy path', () => {
  const { server } = makeRestMock();
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterAll(() => server.close());

  it('POST /v1/memories returns 201 body', async () => {
    const c = createRestClient({ config: cfg(), deviceId: 'anon_x', version: 'test', logger });
    const r = await c.request<{ id: string }>({
      method: 'POST',
      path: '/v1/memories',
      body: { content: 'hi' },
    });
    expect(r.id).toMatch(/^mem_/);
  });

  it('GET /v1/memories/:id includes Authorization header', async () => {
    let captured = '';
    const listener = ({ request }: { request: Request }) => {
      if (request.url.includes('/v1/memories/')) {
        captured = request.headers.get('authorization') ?? '';
      }
    };
    server.events.on('request:start', listener);
    const c = createRestClient({ config: cfg(), deviceId: 'anon_x', version: 'test', logger });
    await c.request({ method: 'GET', path: '/v1/memories/mem_xyz' });
    server.events.removeListener('request:start', listener);
    expect(captured).toBe('Bearer ki_sk_test_key_1234');
  });
});

describe('RestClient retries on 5xx', () => {
  const { server } = makeFlakyMock('https://api.kireo.example', 2);
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterAll(() => server.close());

  it('two flakes then success', async () => {
    const c = createRestClient({ config: cfg(), deviceId: 'anon_x', version: 'test', logger });
    const r = await c.request<{ id: string }>({ method: 'POST', path: '/v1/memories', body: {} });
    expect(r.id).toBeTruthy();
  });
});

describe('RestClient surfaces 402 RestApiError', () => {
  const { server } = makeFailingMock('quota_exceeded');
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterAll(() => server.close());

  it('throws with httpStatus 402', async () => {
    const c = createRestClient({
      config: cfg({ retryMaxAttempts: 0 }),
      deviceId: 'anon_x',
      version: 'test',
      logger,
    });
    await expect(
      c.request({ method: 'POST', path: '/v1/memories', body: {} }),
    ).rejects.toMatchObject({ name: 'RestApiError', httpStatus: 402 });
  });
});
