import { describe, expect, it } from 'vitest';

import { INDEX_HEAD_TAG, readIndexHead, writeIndexHead } from '../../src/index/index-head.js';
import type { RestClient } from '../../src/rest/client.js';

const NS = 'ctx-demo';
/** The (code bucket, index root) an anchor belongs to. */
const SCOPE = { codeNs: 'code-demo', indexRoot: '' };
const OTHER_SCOPE = { codeNs: 'code-other', indexRoot: '' };
/** Metadata a scoped anchor row carries, for seeding. */
const scoped = (commit: string, scope = SCOPE) => ({
  commit,
  code_ns: scope.codeNs,
  index_root: scope.indexRoot,
});

interface StoredRow {
  id: string;
  namespace: string;
  content: string;
  type: string;
  tags: string[];
  occurred_at: string;
  metadata: Record<string, unknown>;
  deleted: boolean;
}

interface FakeReq {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/**
 * In-memory stand-in for the /v1/memories surface writeIndexHead touches:
 * GET list (soft-deleted rows excluded), POST create, DELETE-by-id
 * (soft delete). Rows persist across requests so the test can inspect what a
 * sequence of calls actually left in the bucket.
 */
class FakeMemoryStore {
  rows: StoredRow[] = [];
  private nextId = 1;

  seed(row: Partial<StoredRow> & { occurred_at: string }): StoredRow {
    const stored: StoredRow = {
      id: `m-${String(this.nextId++).padStart(3, '0')}`,
      namespace: row.namespace ?? NS,
      content: row.content ?? 'seeded',
      type: row.type ?? 'fact',
      tags: row.tags ?? [INDEX_HEAD_TAG],
      occurred_at: row.occurred_at,
      metadata: row.metadata ?? {},
      deleted: false,
    };
    this.rows.push(stored);
    return stored;
  }

  handle(req: FakeReq): unknown {
    if (req.method === 'GET' && req.path.startsWith('/v1/memories?')) {
      const ns = new URL(`http://x${req.path}`).searchParams.get('namespace');
      // `items`, matching the real GET /v1/memories envelope
      // (apps/api/src/memory/service.ts#ListResult). This fake used to answer
      // under `data`, faithfully reproducing the client's own bug.
      return { items: this.rows.filter((r) => !r.deleted && r.namespace === ns) };
    }
    if (req.method === 'POST' && req.path === '/v1/memories') {
      const body = req.body as {
        namespace: string;
        content: string;
        type: string;
        tags: string[];
        occurred_at: string;
        metadata: Record<string, unknown>;
      };
      const row = this.seed({ ...body });
      return { id: row.id };
    }
    if (req.method === 'DELETE' && req.path.startsWith('/v1/memories/')) {
      const id = decodeURIComponent(req.path.slice('/v1/memories/'.length));
      const row = this.rows.find((r) => r.id === id);
      if (row) row.deleted = true;
      return {};
    }
    throw new Error(`unhandled ${req.method} ${req.path}`);
  }

  liveHeads(): StoredRow[] {
    return this.rows.filter((r) => !r.deleted && r.tags.includes(INDEX_HEAD_TAG));
  }
}

/** RestClient that executes each request immediately against the store. */
function immediateRest(store: FakeMemoryStore): RestClient {
  return {
    request: async (req: FakeReq) => store.handle(req),
  } as unknown as RestClient;
}

/**
 * RestClient that parks every request in a FIFO queue instead of executing
 * it, so a test can interleave two concurrent callers step by step. `drain`
 * services the queue one request per event-loop turn until `done` settles —
 * with two writers started back-to-back this yields the adversarial order
 * (A.create, B.create, A.list, B.list, A/B deletes) in which both writers
 * observe each other's rows mid-flight: exactly the two-devices-finish-
 * at-once race from the review.
 */
function scriptedRest(store: FakeMemoryStore): {
  rest: RestClient;
  drain: (done: Promise<unknown>) => Promise<void>;
} {
  const pending: Array<{
    req: FakeReq;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }> = [];
  const rest = {
    request: (req: FakeReq) =>
      new Promise((resolve, reject) => {
        pending.push({ req, resolve, reject });
      }),
  } as unknown as RestClient;

  const drain = async (done: Promise<unknown>): Promise<void> => {
    let settled = false;
    void done.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    while (!settled || pending.length > 0) {
      const next = pending.shift();
      if (next) {
        try {
          next.resolve(store.handle(next.req));
        } catch (err) {
          next.reject(err);
        }
      }
      // Yield so the caller we just unblocked can enqueue its next request
      // before the other caller's queued one is serviced.
      await new Promise((r) => setImmediate(r));
    }
  };
  return { rest, drain };
}

describe('index-head read/write round trip', () => {
  it('write then read returns the commit, with exactly one live row', async () => {
    const store = new FakeMemoryStore();
    const rest = immediateRest(store);

    await writeIndexHead(rest, NS, { commit: 'c1', ts: '2026-08-30T10:00:00.000Z' }, SCOPE);

    expect(await readIndexHead(rest, NS, SCOPE)).toMatchObject({ commit: 'c1' });
    expect(store.liveHeads()).toHaveLength(1);
  });

  it('a second write replaces the first and still leaves exactly one live row', async () => {
    const store = new FakeMemoryStore();
    const rest = immediateRest(store);

    await writeIndexHead(rest, NS, { commit: 'c1', ts: '2026-08-30T10:00:00.000Z' }, SCOPE);
    await writeIndexHead(rest, NS, { commit: 'c2', ts: '2026-08-30T11:00:00.000Z' }, SCOPE);

    expect(await readIndexHead(rest, NS, SCOPE)).toMatchObject({ commit: 'c2' });
    expect(store.liveHeads()).toHaveLength(1);
  });
});

describe('index-head concurrent writers (review finding: non-atomic overwrite)', () => {
  it('two devices finishing an index at once converge to ONE live anchor row', async () => {
    const store = new FakeMemoryStore();
    // The stale anchor both writers will race to replace.
    store.seed({ occurred_at: '2026-08-30T09:00:00.000Z', metadata: scoped('c0') });

    const { rest, drain } = scriptedRest(store);
    const race = Promise.all([
      writeIndexHead(rest, NS, { commit: 'ca', ts: '2026-08-30T10:00:00.001Z' }, SCOPE),
      writeIndexHead(rest, NS, { commit: 'cb', ts: '2026-08-30T10:00:00.002Z' }, SCOPE),
    ]);
    await drain(race);
    await race;

    // The old read→delete-one→create order left BOTH ca and cb alive here.
    const live = store.liveHeads();
    expect(live).toHaveLength(1);
    expect(live[0]?.metadata.commit).toBe('cb'); // deterministic: newest ts wins
    expect(await readIndexHead(immediateRest(store), NS, SCOPE)).toMatchObject({ commit: 'cb' });
  });

  it('a write sweeps orphan rows left behind by earlier races, not just one row', async () => {
    const store = new FakeMemoryStore();
    store.seed({ occurred_at: '2026-08-30T09:00:00.000Z', metadata: scoped('ca') });
    store.seed({ occurred_at: '2026-08-30T09:00:00.001Z', metadata: scoped('cb') });

    await writeIndexHead(
      immediateRest(store),
      NS,
      { commit: 'c2', ts: '2026-08-30T10:00:00.000Z' },
      SCOPE,
    );

    const live = store.liveHeads();
    expect(live).toHaveLength(1);
    expect(live[0]?.metadata.commit).toBe('c2');
  });
});

describe('index-head failure behavior', () => {
  it('a failed create leaves the previous anchor untouched (create-before-sweep)', async () => {
    const store = new FakeMemoryStore();
    const rest = immediateRest(store);
    await writeIndexHead(rest, NS, { commit: 'c1', ts: '2026-08-30T10:00:00.000Z' }, SCOPE);

    const failingRest = {
      request: async (req: FakeReq) => {
        if (req.method === 'POST') throw new Error('503 service unavailable');
        return store.handle(req);
      },
    } as unknown as RestClient;

    await expect(
      writeIndexHead(failingRest, NS, { commit: 'c2', ts: '2026-08-30T11:00:00.000Z' }, SCOPE),
    ).rejects.toThrow(/503/);

    // The old delete-then-create order would have lost the anchor here.
    expect(await readIndexHead(rest, NS, SCOPE)).toMatchObject({ commit: 'c1' });
    expect(store.liveHeads()).toHaveLength(1);
  });

  it('readIndexHead picks the newest anchor while orphans still exist', async () => {
    const store = new FakeMemoryStore();
    store.seed({ occurred_at: '2026-08-30T09:00:00.000Z', metadata: scoped('c-old') });
    store.seed({ occurred_at: '2026-08-30T09:30:00.000Z', metadata: scoped('c-new') });

    expect(await readIndexHead(immediateRest(store), NS, SCOPE)).toMatchObject({ commit: 'c-new' });
  });

  it('readIndexHead skips a newer row whose metadata lost its commit', async () => {
    const store = new FakeMemoryStore();
    store.seed({ occurred_at: '2026-08-30T09:00:00.000Z', metadata: scoped('c-valid') });
    store.seed({
      occurred_at: '2026-08-30T10:00:00.000Z',
      metadata: { code_ns: SCOPE.codeNs, index_root: SCOPE.indexRoot },
    });

    expect(await readIndexHead(immediateRest(store), NS, SCOPE)).toMatchObject({
      commit: 'c-valid',
    });
  });
});

describe('index-head scoping (review finding: one anchor per project, several code buckets)', () => {
  it("a second code bucket in the SAME project does not inherit the first one's anchor", async () => {
    const store = new FakeMemoryStore();
    const rest = immediateRest(store);

    // `kireo index apps/api --repo api` finishes and anchors at c1.
    await writeIndexHead(rest, NS, { commit: 'c1', ts: '2026-08-30T10:00:00.000Z' }, SCOPE);

    // `kireo index apps/web --repo web` shares the git remote, therefore the
    // ctx bucket. It must NOT see code-demo's anchor — that is what made
    // `git diff HEAD..HEAD` empty and left the second bucket permanently empty
    // while the run logged success.
    expect(await readIndexHead(rest, NS, OTHER_SCOPE)).toBeNull();
  });

  it('two code buckets keep their own anchors alive side by side', async () => {
    const store = new FakeMemoryStore();
    const rest = immediateRest(store);

    await writeIndexHead(rest, NS, { commit: 'c1', ts: '2026-08-30T10:00:00.000Z' }, SCOPE);
    await writeIndexHead(rest, NS, { commit: 'c2', ts: '2026-08-30T11:00:00.000Z' }, OTHER_SCOPE);

    expect(await readIndexHead(rest, NS, SCOPE)).toMatchObject({ commit: 'c1' });
    expect(await readIndexHead(rest, NS, OTHER_SCOPE)).toMatchObject({ commit: 'c2' });
    // One per scope, and the sweep must not have eaten the other scope's row.
    expect(store.liveHeads()).toHaveLength(2);
  });

  it('the same repo indexed at two roots keeps two anchors', async () => {
    const store = new FakeMemoryStore();
    const rest = immediateRest(store);
    const sub = { codeNs: 'code-demo', indexRoot: 'apps/api' };

    await writeIndexHead(rest, NS, { commit: 'c1', ts: '2026-08-30T10:00:00.000Z' }, SCOPE);
    await writeIndexHead(rest, NS, { commit: 'c2', ts: '2026-08-30T11:00:00.000Z' }, sub);

    expect(await readIndexHead(rest, NS, SCOPE)).toMatchObject({ commit: 'c1' });
    expect(await readIndexHead(rest, NS, sub)).toMatchObject({ commit: 'c2' });
  });

  it('an unscoped legacy anchor is never read, and is swept on the next write', async () => {
    const store = new FakeMemoryStore();
    const rest = immediateRest(store);
    // Written by a client that predates scoping: no code_ns, so there is no
    // way to know which code bucket it describes.
    store.seed({ occurred_at: '2026-08-30T09:00:00.000Z', metadata: { commit: 'legacy' } });

    // Degrades to null → one full scan, which is the safe direction.
    expect(await readIndexHead(rest, NS, SCOPE)).toBeNull();

    await writeIndexHead(rest, NS, { commit: 'c1', ts: '2026-08-30T10:00:00.000Z' }, SCOPE);
    const live = store.liveHeads();
    expect(live).toHaveLength(1);
    expect(live[0]?.metadata.commit).toBe('c1');
  });
});
