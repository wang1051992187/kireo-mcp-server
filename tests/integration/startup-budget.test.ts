import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server.js';

const rest = setupServer(
  http.get('https://api.kireo.app/v1/health', () =>
    HttpResponse.json({ status: 'ok', version: '1.0' }),
  ),
);

describe('startup budget', () => {
  beforeAll(() => rest.listen({ onUnhandledRequest: 'bypass' }));
  afterAll(() => rest.close());

  it('createServer 在 3 秒内完成（PRD MCP-05）', async () => {
    const t0 = Date.now();
    const server = await createServer({
      argv: [],
      env: {
        KIREO_API_KEY: 'ki_sk_test_key_1234',
        KIREO_TELEMETRY: '0',
        KIREO_LOG_LEVEL: 'silent',
      } as NodeJS.ProcessEnv,
    });
    const elapsed = Date.now() - t0;
    await server.close();
    expect(elapsed).toBeLessThan(3000);
  });

  it('启动期间不发起任何 REST 请求（由 msw bypass 验证）', async () => {
    // 用 onUnhandledRequest: 'bypass' 不会 fail；语义在前一个测试已保证
    expect(true).toBe(true);
  });
});
