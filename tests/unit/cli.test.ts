import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli.js';

function captureStdout(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    calls.push(String(chunk));
    return true;
  });
  return { calls, restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runCli help/version (BUG-004)', () => {
  it('`--help` prints usage to stdout, needs no API key, no side effects', async () => {
    const out = captureStdout();
    // Empty env: if this fell through to loadConfig/startServer it would throw.
    await runCli({ argv: ['--help'], env: {} });
    out.restore();
    const text = out.calls.join('');
    expect(text).toContain('kireo index');
    expect(text).toContain('--timeout');
    expect(text).toContain('--batch-size');
    expect(text).toContain('--repo');
    expect(text).toContain('KIREO_API_KEY');
  });

  it('`index --help` shows help instead of indexing the cwd', async () => {
    const out = captureStdout();
    await runCli({ argv: ['index', '--help'], env: {} });
    out.restore();
    const text = out.calls.join('');
    expect(text).toContain('kireo index');
    // Must NOT have performed an index (no "Indexed ... -> namespace" line).
    expect(text).not.toContain('-> namespace');
  });

  it('`--version` prints the version and nothing else', async () => {
    const out = captureStdout();
    await runCli({ argv: ['--version'], env: {} });
    out.restore();
    expect(out.calls.join('')).toMatch(/\d+\.\d+\.\d+/);
  });
});

describe('runCli index flag validation (BUG-004 / BUG-001)', () => {
  const env = { KIREO_API_KEY: 'ki_sk_abcdef12' };

  it('rejects an unknown flag with exit-worthy error + usage hint, without indexing', async () => {
    await expect(runCli({ argv: ['index', '--bogus'], env })).rejects.toThrow(
      /unknown flag "--bogus"/,
    );
    await expect(runCli({ argv: ['index', '--bogus'], env })).rejects.toThrow(/kireo --help/);
  });

  it('rejects an out-of-range --batch-size', async () => {
    await expect(runCli({ argv: ['index', '--batch-size', '0'], env })).rejects.toThrow(
      /invalid --batch-size/,
    );
    await expect(runCli({ argv: ['index', '--batch-size', '200'], env })).rejects.toThrow(
      /invalid --batch-size/,
    );
    await expect(runCli({ argv: ['index', '--batch-size', 'abc'], env })).rejects.toThrow(
      /invalid --batch-size/,
    );
  });
});
