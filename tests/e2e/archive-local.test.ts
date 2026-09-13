import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMORY_LIMITS } from '@kireo/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';

// Run via `pnpm plugin:verify`. Uses real stdio and HTTP, but only a loopback
// receiver with synthetic content/key. No production service or account is used.
const root = fileURLToPath(new URL('../../../..', import.meta.url));
const localPluginsBuilt = existsSync(join(root, '.local-plugins/codex/kireo/.mcp.json'));
it.runIf(localPluginsBuilt)(
  'both local plugin manifests launch a server that archives, uploads and dedupes',
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kireo-plugin-loop-'));
    const cwd = join(workspace, '对话项目');
    mkdirSync(cwd);
    const received: { content: string; namespace: string; metadata: Record<string, unknown> }[] =
      [];
    const records = new Map<string, string>();
    const receiver = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/memories/batch') {
        res.writeHead(404).end();
        return;
      }
      const buffers: Buffer[] = [];
      for await (const buffer of req) buffers.push(Buffer.from(buffer));
      const body = JSON.parse(Buffer.concat(buffers).toString('utf8'));
      if (req.headers.authorization !== 'Bearer ki_sk_local_plugin_test') {
        res.writeHead(401).end();
        return;
      }
      const succeeded = body.items.map((item: (typeof received)[number], index: number) => {
        received.push(item);
        const key = `${item.namespace}:${item.content}`;
        const existing = records.get(key);
        const id = existing ?? `test-memory-${records.size}`;
        records.set(key, id);
        return { index, id, deduped: !!existing };
      });
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ succeeded, failures: [] }));
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const address = receiver.address();
    if (!address || typeof address === 'string') throw new Error('loopback listener unavailable');
    try {
      for (const host of ['codex', 'claude-code'] as const) {
        const manifest = JSON.parse(
          readFileSync(join(root, '.local-plugins', host, 'kireo', '.mcp.json'), 'utf8'),
        );
        const client = new Client({ name: 'archive-test', version: '1' });
        const transport = new StdioClientTransport({
          ...manifest.mcpServers.kireo,
          cwd: workspace, // Explicit conversation cwd must win over MCP cwd.
          env: {
            KIREO_API_URL: `http://127.0.0.1:${address.port}`,
            KIREO_API_KEY: 'ki_sk_local_plugin_test',
            KIREO_TELEMETRY: '0',
            KIREO_LOG_LEVEL: 'silent',
            KIREO_REQUEST_TIMEOUT_MS: '2000',
            KIREO_RETRY_MAX_ATTEMPTS: '0',
          },
          stderr: 'pipe',
        });
        try {
          await client.connect(transport);
          expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
            'context_archive',
          );
          const summary = `# 对话项目\n\n保留本地副本，线上部署要等用户确认。\n${'测试结果和待完成事项。'.repeat(1000)}`;
          const arguments_ = { cwd, summary, session_id: 'local-test', host };
          const beforePreview = received.length;
          const preview = await client.callTool({
            name: 'context_archive',
            arguments: { ...arguments_, dry_run: true },
          });
          expect(preview.isError).not.toBe(true);
          expect(received).toHaveLength(beforePreview);
          const saved = await client.callTool({ name: 'context_archive', arguments: arguments_ });
          expect(saved.isError).not.toBe(true);
          const text = (saved.content as { text: string }[])[0]?.text ?? '';
          const result = JSON.parse(
            text.slice(text.indexOf('```json\n') + 8, text.lastIndexOf('\n```')),
          );
          expect(result.outbox_pending).toBe(false);
          expect(result.filename).toBe('对话项目.md');
          expect(readFileSync(result.local_path, 'utf8')).toBe(summary);
          expect(result.memory_ids.length).toBeGreaterThan(1);
          const retried = await client.callTool({ name: 'context_archive', arguments: arguments_ });
          expect((retried.content as { text: string }[])[0]?.text).toContain('"stored": 0');
        } finally {
          await client.close();
          await transport.close();
        }
      }
      expect(records.size).toBe(2);
      expect(received.length).toBe(8);
      for (const item of received) {
        expect(item.content.length).toBeLessThanOrEqual(MEMORY_LIMITS.CONTENT_MAX);
        expect(item.metadata.filename).toBe('对话项目.md');
        expect(item.namespace).toMatch(MEMORY_LIMITS.NAMESPACE_REGEX);
        expect(JSON.stringify(item)).not.toContain(workspace);
      }
    } finally {
      receiver.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        receiver.close((err) => (err ? reject(err) : resolve())),
      );
      rmSync(workspace, { recursive: true, force: true });
    }
  },
  20_000,
);
