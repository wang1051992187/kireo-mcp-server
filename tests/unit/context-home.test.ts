import { HOME_NAMESPACE } from '@kireo/shared';
import { describe, expect, it, vi } from 'vitest';
import { listHomeCards, upsertHomeCard } from '../../src/context/home.js';

describe('upsertHomeCard', () => {
  it('writes the new card into the kireo-home namespace', async () => {
    const request = vi.fn(async (req: { method: string; body?: unknown }) =>
      req.method === 'GET' ? { items: [], next_cursor: null } : {},
    );
    await upsertHomeCard({ request } as never, {
      projectKey: 'github.com/a/b',
      displayName: 'b',
      ctxNs: 'ctx-b-111111',
      headline: '在做项目身份解析',
    });
    const post = request.mock.calls.find((c) => c[0].method === 'POST');
    expect(post?.[0].body).toMatchObject({
      namespace: HOME_NAMESPACE,
      content: '在做项目身份解析',
      metadata: { project_key: 'github.com/a/b' },
    });
  });

  it('deletes the previous card for the same project BEFORE writing the new one', async () => {
    // Overwrite semantics: the home bucket must hold exactly one card per
    // project, or `resume --all` degrades into a changelog.
    const request = vi.fn(async (req) =>
      req.method === 'GET'
        ? { items: [{ id: 'old', metadata: { project_key: 'github.com/a/b' } }], next_cursor: null }
        : {},
    );
    await upsertHomeCard({ request } as never, {
      projectKey: 'github.com/a/b',
      displayName: 'b',
      ctxNs: 'ctx-b-111111',
      headline: '在做项目身份解析',
    });
    const methods = request.mock.calls.map((c) => c[0].method);
    expect(methods.indexOf('DELETE')).toBeLessThan(methods.lastIndexOf('POST'));
    expect(methods).toContain('DELETE');
  });

  it('does NOT delete anything when no old card exists for the project', async () => {
    const request = vi.fn(async (req: { method: string }) =>
      req.method === 'GET'
        ? {
            items: [{ id: 'other', metadata: { project_key: 'github.com/x/y' } }],
            next_cursor: null,
          }
        : {},
    );
    await upsertHomeCard({ request } as never, {
      projectKey: 'github.com/a/b',
      displayName: 'b',
      ctxNs: 'ctx-b-111111',
      headline: 'x',
    });
    const methods = request.mock.calls.map((c) => c[0].method);
    expect(methods).not.toContain('DELETE');
    expect(methods).toContain('POST');
  });

  it('still writes the new card when deleting the old one fails', async () => {
    const request = vi.fn(async (req) => {
      if (req.method === 'GET') {
        return {
          items: [{ id: 'old', metadata: { project_key: 'github.com/a/b' } }],
          next_cursor: null,
        };
      }
      if (req.method === 'DELETE') throw new Error('gone');
      return {};
    });
    await expect(
      upsertHomeCard({ request } as never, {
        projectKey: 'github.com/a/b',
        displayName: 'b',
        ctxNs: 'ctx-b-111111',
        headline: 'x',
      }),
    ).resolves.toBeUndefined();
    expect(request.mock.calls.some((c) => c[0].method === 'POST')).toBe(true);
  });

  it('still writes the new card when the lookup for an old one fails entirely', async () => {
    const request = vi.fn(async (req: { method: string }) => {
      if (req.method === 'GET') throw new Error('network down');
      return {};
    });
    await expect(
      upsertHomeCard({ request } as never, {
        projectKey: 'github.com/a/b',
        displayName: 'b',
        ctxNs: 'ctx-b-111111',
        headline: 'x',
      }),
    ).resolves.toBeUndefined();
    expect(request.mock.calls.some((c) => c[0].method === 'POST')).toBe(true);
  });
});

describe('listHomeCards', () => {
  it('returns cards sorted by ts descending, regardless of API order', async () => {
    const request = vi.fn(async () => ({
      items: [
        {
          id: 'm1',
          content: '卡在 SSE 断连重试',
          occurred_at: '2026-08-27T00:00:00.000Z',
          metadata: { project_key: 'github.com/x/ratfish-web', display_name: 'ratfish-web' },
        },
        {
          id: 'm2',
          content: '正在做插件的项目身份四级解析',
          occurred_at: '2026-08-30T08:00:00.000Z',
          metadata: { project_key: 'github.com/x/kireo', display_name: 'kireo' },
        },
      ],
      next_cursor: null,
    }));
    const cards = await listHomeCards({ request } as never);
    expect(cards.map((c) => c.projectKey)).toEqual([
      'github.com/x/kireo',
      'github.com/x/ratfish-web',
    ]);
    expect(cards[0]?.headline).toBe('正在做插件的项目身份四级解析');
  });

  it('skips rows with no project_key in metadata', async () => {
    const request = vi.fn(async () => ({
      items: [{ id: 'stray', content: 'not a home card', metadata: {} }],
      next_cursor: null,
    }));
    const cards = await listHomeCards({ request } as never);
    expect(cards).toEqual([]);
  });
});

describe('home list envelope', () => {
  it('errors loudly on the wrong envelope instead of reporting "no projects yet"', async () => {
    // Reading `data` (what this module used to do) makes `resume --all` print
    // "还没有任何项目的摘要卡" forever AND makes upsertHomeCard never see the
    // previous card, so it never issues the DELETE that keeps this bucket at
    // one live card per project. Both failures look like normal operation.
    const request = vi.fn(async () => ({
      data: [{ id: 'x', metadata: { project_key: 'github.com/a/b' } }],
      next_cursor: null,
    }));
    await expect(listHomeCards({ request } as never)).rejects.toThrow(/items/);
  });
});
