import { http, HttpResponse, delay } from 'msw';
import { setupServer } from 'msw/node';
import errorsFx from './fixtures/error-envelopes.json' with { type: 'json' };
import memoryFx from './fixtures/memory.json' with { type: 'json' };
import searchFx from './fixtures/search-result.json' with { type: 'json' };

export const FIXTURES = { memoryFx, searchFx, errorsFx };

type ErrorKind = keyof typeof errorsFx;

export function makeRestMock(baseUrl = 'https://api.kireo.example') {
  const server = setupServer(
    http.get(`${baseUrl}/v1/health`, () => HttpResponse.json({ status: 'ok', version: '1.0.0' })),
    http.post(`${baseUrl}/v1/memories`, () => HttpResponse.json(memoryFx, { status: 201 })),
    http.get(`${baseUrl}/v1/memories/:id`, ({ params }) =>
      HttpResponse.json({ ...memoryFx, id: params.id }),
    ),
    http.patch(`${baseUrl}/v1/memories/:id`, () =>
      HttpResponse.json({ ...memoryFx, updated_at: new Date().toISOString() }),
    ),
    http.delete(`${baseUrl}/v1/memories/:id`, () => new HttpResponse(null, { status: 204 })),
    http.post(`${baseUrl}/v1/search`, () => HttpResponse.json(searchFx)),
    http.post(`${baseUrl}/v1/recall`, () => HttpResponse.json(searchFx)),
    http.get(`${baseUrl}/v1/namespaces`, () =>
      HttpResponse.json({
        namespaces: [{ name: 'default', count: 12, last_active: '2026-05-25T01:00:00Z' }],
      }),
    ),
  );
  return { server, baseUrl };
}

export function makeFailingMock(kind: ErrorKind, baseUrl = 'https://api.kireo.example') {
  const env = errorsFx[kind];
  const status =
    kind === 'auth_invalid'
      ? 401
      : kind === 'quota_exceeded'
        ? 402
        : kind === 'rate_limited'
          ? 429
          : kind === 'validation'
            ? 400
            : 500;
  const server = setupServer(
    http.post(`${baseUrl}/v1/memories`, () => HttpResponse.json(env, { status })),
    http.post(`${baseUrl}/v1/search`, () => HttpResponse.json(env, { status })),
  );
  return { server, baseUrl };
}

export function makeFlakyMock(baseUrl = 'https://api.kireo.example', failTimes = 2) {
  let n = 0;
  const server = setupServer(
    http.post(`${baseUrl}/v1/memories`, async () => {
      if (n++ < failTimes) {
        await delay(5);
        return HttpResponse.json(errorsFx.internal, { status: 503 });
      }
      return HttpResponse.json(memoryFx, { status: 201 });
    }),
  );
  return { server, baseUrl };
}
