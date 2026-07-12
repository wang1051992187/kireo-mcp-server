import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runInspector } from '../helpers/inspector-runner.js';

const SKIP = process.env.CI_SKIP_INSPECTOR === '1';

describe.skipIf(SKIP)('@modelcontextprotocol/inspector e2e', () => {
  beforeAll(() => {
    const dist = join(process.cwd(), 'dist/index.cjs');
    if (!existsSync(dist)) {
      throw new Error('Run `pnpm -F @kireo/mcp-server build` before this e2e test');
    }
  });

  it('inspector list_tools 返回 8 个 tool', async () => {
    const r = await runInspector(['--method', 'tools/list'], {
      KIREO_API_KEY: 'ki_sk_test_key_1234',
      KIREO_TELEMETRY: '0',
      KIREO_LOG_LEVEL: 'silent',
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/memory_save/);
    expect(r.stdout).toMatch(/memory_health/);
    const matched = r.stdout.match(/memory_[a-z_]+/g) ?? [];
    expect(new Set(matched).size).toBeGreaterThanOrEqual(8);
  }, 30_000);
});
