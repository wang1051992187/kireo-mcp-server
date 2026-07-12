import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { walkRepo } from '../../src/index/walk.js';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'kireo-walk-'));
  writeFileSync(join(root, '.gitignore'), 'ignored.ts\n');
  writeFileSync(join(root, 'keep.ts'), 'export function a() {}');
  writeFileSync(join(root, 'ignored.ts'), 'export function b() {}');
  writeFileSync(join(root, 'readme.md'), '# nope'); // unsupported ext
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', 'x.ts'), 'export function c() {}');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'big.ts'), 'x'.repeat(1_000_001));
  writeFileSync(join(root, 'src', 'bin.ts'), Buffer.from([0x61, 0x00, 0x62])); // a NUL b
  writeFileSync(join(root, 'src', 'ok.py'), 'def d():\n  pass');
  return root;
}

const root = fixture();
afterAll(() => { /* tmp dir auto-cleaned by OS */ });

describe('walkRepo', () => {
  it('returns only supported, non-ignored, small, text files', async () => {
    const files = (await walkRepo(root)).map((f) => f.relPath).sort();
    expect(files).toEqual(['keep.ts', 'src/ok.py']);
  });

  it('skips broken symlinks and continues without aborting', async () => {
    const root2 = mkdtempSync(join(tmpdir(), 'kireo-walk-symlink-'));
    writeFileSync(join(root2, 'valid.ts'), 'export function valid() {}');
    symlinkSync('/nonexistent/target', join(root2, 'broken-link'), 'file');
    const files = (await walkRepo(root2)).map((f) => f.relPath).sort();
    expect(files).toEqual(['valid.ts']);
  });
});
