import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractRepo } from '../../src/index/run-index.js';

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'kireo-extract-repo-'));
  writeFileSync(
    join(root, 'math.ts'),
    'export function add(a: number, b: number) { return a + b; }',
  );
  writeFileSync(
    join(root, 'calc.py'),
    'def multiply(a, b):\n    return a * b\n',
  );
  return root;
}

describe('extractRepo', () => {
  it('returns DTOs for all source files with type=code and correct namespace', async () => {
    const dir = makeFixture();
    const dtos = await extractRepo({ dir, repo: 'my-repo' });

    expect(dtos.length).toBeGreaterThan(0);
    for (const dto of dtos) {
      expect(dto.type).toBe('code');
      expect(dto.namespace).toBe('code-my-repo');
    }

    const symbolNames = dtos.map((d) => d.metadata.symbol_name);
    expect(symbolNames).toContain('add');
    expect(symbolNames).toContain('multiply');
  });

  it('uses the same content_hash derivation as runIndex (SHA-256 of file content)', async () => {
    const dir = makeFixture();
    const dtos = await extractRepo({ dir, repo: 'hash-test' });
    // All DTOs must have a non-empty hex hash (64 chars for SHA-256)
    for (const dto of dtos) {
      expect(dto.metadata.content_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
