import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server.js';

const rest = setupServer(
  http.get('https://api.kireo.app/v1/health', () =>
    HttpResponse.json({ status: 'ok', version: '1.0' }),
  ),
);

describe('server handshake', () => {
  beforeAll(() => rest.listen({ onUnhandledRequest: 'error' }));
  afterAll(() => rest.close());

  it('握手成功并能 list_tools', async () => {
    const server = await createServer({
      argv: [],
      env: {
        KIREO_API_KEY: 'ki_sk_test_key_1234',
        KIREO_TELEMETRY: '0',
        KIREO_LOG_LEVEL: 'silent',
      } as NodeJS.ProcessEnv,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(a), client.connect(b)]);

    // Exact list, in registry order (src/tools/index.ts). Pinned deliberately:
    // an accidentally dropped or renamed tool is a breaking change for every
    // host config that references it by name. The three context-relay tools
    // were added on this branch without updating this list, which is why
    // `pnpm test` has been red.
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual([
      'memory_save',
      'memory_search',
      'memory_recall',
      'memory_get',
      'memory_update',
      'memory_delete',
      'memory_list_namespaces',
      'memory_health',
      'project_info',
      'context_save',
      'context_load',
      'context_archive',
    ]);

    await client.close();
    await server.close();
  });
});
