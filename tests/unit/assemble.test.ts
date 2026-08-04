import { MEMORY_LIMITS } from '@kireo/shared';
import { describe, expect, it } from 'vitest';
import { assembleSymbol, codeNamespace } from '../../src/index/assemble.js';
import type { ExtractedSymbol } from '../../src/index/extractor.js';

const sym: ExtractedSymbol = {
  name: 'add', kind: 'function', startLine: 2, endLine: 4,
  signature: 'export function add(a: number, b: number): number',
  docstring: '/** Adds. */', isExported: true,
  source: 'export function add(a: number, b: number): number {\n  return a + b;\n}',
};

describe('codeNamespace', () => {
  it('prefixes code- and stays within NAMESPACE_REGEX', () => {
    const ns = codeNamespace('My Repo!!');
    expect(ns.startsWith('code-')).toBe(true);
    expect(MEMORY_LIMITS.NAMESPACE_REGEX.test(ns)).toBe(true);
  });

  // Negative-path note: a NAMESPACE_REGEX violation via codeNamespace() is not
  // reachable in practice. repoSlug() always produces a non-empty lowercase
  // [a-z0-9_-] string capped at 27 chars, so "code-<slug>" is always ≤32 chars
  // and always matches /^[a-z0-9_-]{1,32}$/. The guard in codeNamespace()
  // exists as a defence-in-depth assertion; no test is added for it.
});

describe('assembleSymbol', () => {
  it('builds the locked CreateMemoryDTO', () => {
    const dto = assembleSymbol({
      symbol: sym, filePath: 'src/math.ts', language: 'typescript',
      repo: 'demo', namespace: 'code-demo', contentHash: 'abc123',
    });
    expect(dto.type).toBe('code');
    expect(dto.namespace).toBe('code-demo');
    // The signature already opens `source`, so it is NOT prepended again; the
    // JSDoc docstring lives above the node (not in source) so it IS kept once.
    expect(dto.content).toBe(`${sym.docstring}\n${sym.source}`);
    expect(dto.metadata).toEqual({
      file_path: 'src/math.ts', start_line: 2, end_line: 4, kind: 'function',
      symbol_name: 'add', language: 'typescript', is_exported: true,
      repo: 'demo', content_hash: 'abc123',
    });
  });

  it('truncates the snippet so content stays <= CONTENT_MAX', () => {
    const big: ExtractedSymbol = { ...sym, source: 'x'.repeat(20_000) };
    const dto = assembleSymbol({
      symbol: big, filePath: 'a.ts', language: 'typescript',
      repo: 'demo', namespace: 'code-demo', contentHash: 'h',
    });
    expect(dto.content.length).toBeLessThanOrEqual(MEMORY_LIMITS.CONTENT_MAX);
  });

  // Fix 1: metadata size guard
  it('throws when file_path makes serialized metadata exceed METADATA_BYTES_MAX', () => {
    // A path of 2000 chars pushes JSON.stringify(metadata) well past 2048 bytes
    const longPath = 'a/'.repeat(1000); // 2000 chars
    expect(() =>
      assembleSymbol({
        symbol: sym, filePath: longPath, language: 'typescript',
        repo: 'demo', namespace: 'code-demo', contentHash: 'abc123',
      }),
    ).toThrow(`METADATA_BYTES_MAX (${MEMORY_LIMITS.METADATA_BYTES_MAX})`);
  });

  // Fix 2: docstring guard — empty/no docstring must not produce "undefined" or a stray blank line
  it('omits docstring line when docstring is empty, no "undefined" in content', () => {
    const noDoc: ExtractedSymbol = { ...sym, docstring: '' };
    const dto = assembleSymbol({
      symbol: noDoc, filePath: 'src/math.ts', language: 'typescript',
      repo: 'demo', namespace: 'code-demo', contentHash: 'abc123',
    });
    expect(dto.content).not.toContain('undefined');
    // Signature already opens source and there is no docstring, so content is
    // exactly the source — no prepended head, no stray blank line.
    expect(dto.content).toBe(noDoc.source);
  });

  // BUG-007: when source already begins with the signature AND contains the
  // docstring (Python style), neither may be duplicated in content.
  it('does not duplicate signature/docstring already present in source', () => {
    const py: ExtractedSymbol = {
      name: 'inc', kind: 'method', startLine: 1, endLine: 4,
      signature: 'def inc(self):',
      docstring: '"""Increment."""',
      isExported: true,
      source: 'def inc(self):\n    """Increment."""\n    self.n += 1\n    return self.n',
    };
    const dto = assembleSymbol({
      symbol: py, filePath: 'counter.py', language: 'python',
      repo: 'demo', namespace: 'code-demo', contentHash: 'h',
    });
    // Content is the source verbatim — signature and docstring appear once each.
    expect(dto.content).toBe(py.source);
    expect(dto.content.match(/def inc\(self\):/g)).toHaveLength(1);
    expect(dto.content.match(/"""Increment\."""/g)).toHaveLength(1);
  });
});
