import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { currentLogFile, ensureLogsDir } from '../../src/observability/log-paths.js';

describe('log paths', () => {
  let tempRoot: string | undefined;

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  it('returns a writable logs directory', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kireo-logs-'));
    const dir = join(tempRoot, 'logs');

    expect(ensureLogsDir(dir)).toBe(dir);
    expect(currentLogFile(dir)).toBe(join(dir, 'mcp-server.log'));
  });

  it('returns undefined when the logs directory cannot be created', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kireo-logs-'));
    const file = join(tempRoot, 'not-a-directory');
    writeFileSync(file, 'x');

    expect(ensureLogsDir(join(file, 'logs'))).toBeUndefined();
  });
});
