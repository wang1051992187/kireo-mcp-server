import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Drives the BUILT MCP server over real stdio JSON-RPC against the LIVE API.
// This is the test that would have caught the read-tool contract drift.
// It self-skips when the API at KIREO_API_URL is not reachable (CI without a
// running stack), mirroring how the API package skips its live-DB tests.

const API = process.env.KIREO_API_URL ?? 'http://localhost:8787';
const PKG_ROOT = fileURLToPath(new URL('../..', import.meta.url));

let apiUp = false;

async function probe(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/v1/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function devSignup(): Promise<string> {
  const res = await fetch(`${API}/v1/dev/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `mcp_e2e_${Date.now()}_${Math.random().toString(36).slice(2)}@kireo.test` }),
  });
  if (!res.ok) throw new Error(`signup failed: ${res.status}`);
  return ((await res.json()) as { api_key: string }).api_key;
}

interface RpcResponse {
  id?: number;
  result?: { content?: Array<{ text: string }>; tools?: unknown[] };
  error?: unknown;
}

function rpc(child: ChildProcess) {
  let buf = '';
  const pending = new Map<number, (v: RpcResponse) => void>();
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString();
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) {
        try {
          const msg = JSON.parse(line) as RpcResponse;
          if (typeof msg.id === 'number' && pending.has(msg.id)) {
            pending.get(msg.id)?.(msg);
            pending.delete(msg.id);
          }
        } catch {
          /* non-JSON log line on stdout — ignore */
        }
      }
      nl = buf.indexOf('\n');
    }
  });
  let id = 0;
  return {
    call(method: string, params?: unknown): Promise<RpcResponse> {
      const myId = ++id;
      return new Promise((resolve) => {
        pending.set(myId, resolve);
        child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
      });
    },
    notify(method: string, params?: unknown): void {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
  };
}

describe('MCP ↔ API end-to-end loop', () => {
  let child: ChildProcess;
  let api: ReturnType<typeof rpc>;

  beforeAll(async () => {
    apiUp = await probe();
    if (!apiUp) return;
    const token = await devSignup();
    child = spawn('node', ['bin/kireo-mcp.cjs'], {
      cwd: PKG_ROOT,
      env: { ...process.env, KIREO_API_URL: API, KIREO_API_KEY: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    api = rpc(child);
    await api.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '1' },
    });
    api.notify('notifications/initialized');
  }, 30_000);

  afterAll(() => {
    child?.kill();
  });

  it('lists 8 tools', (ctx) => {
    if (!apiUp) return ctx.skip();
    return api.call('tools/list').then((r) => {
      expect((r.result?.tools ?? []).length).toBe(8);
    });
  });

  it('save → search → recall → list_namespaces round-trips', async (ctx) => {
    if (!apiUp) return ctx.skip();

    const save = await api.call('tools/call', {
      name: 'memory_save',
      arguments: { content: 'We picked LanceDB for vectors (e2e)', type: 'decision', importance: 0.9 },
    });
    expect(save.error).toBeUndefined();
    expect(save.result?.content?.[0]?.text).toContain('Saved memory mem_');

    const search = await api.call('tools/call', {
      name: 'memory_search',
      arguments: { query: 'LanceDB', limit: 5 },
    });
    expect(search.error).toBeUndefined();
    expect(search.result?.content?.[0]?.text).toMatch(/Found \d+/);
    expect(search.result?.content?.[0]?.text).toContain('LanceDB');

    const recall = await api.call('tools/call', {
      name: 'memory_recall',
      arguments: { namespace: 'default', limit: 5, order: 'recency' },
    });
    expect(recall.error).toBeUndefined();
    expect(recall.result?.content?.[0]?.text).toMatch(/Recalled \d+/);

    const ns = await api.call('tools/call', { name: 'memory_list_namespaces', arguments: {} });
    expect(ns.error).toBeUndefined();
    expect(ns.result?.content?.[0]?.text).toMatch(/You have \d+ namespace/);
  }, 30_000);
});
