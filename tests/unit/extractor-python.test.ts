import { describe, expect, it } from 'vitest';
import { extractSymbols } from '../../src/index/extractor.js';
import { loadParser } from '../../src/index/grammars.js';
import { pythonConfig } from '../../src/index/languages/python.js';

const SRC = [
  'def add(a, b):',
  '    "Adds."',
  '    return a + b',
  '',
  'def _private_fn():',
  '    pass',
  '',
  'class Calc:',
  '    def mul(self, a, b):',
  '        return a * b',
].join('\n');

describe('python extractor', () => {
  it('locks node types', async () => {
    const parser = await loadParser('python');
    const tree = parser.parse(SRC);
    const types = new Set<string>();
    const walk = (n: import('web-tree-sitter').SyntaxNode) => {
      types.add(n.type);
      for (let i = 0; i < n.childCount; i++) walk(n.child(i)!);
    };
    walk(tree!.rootNode);
    expect(types.has('function_definition')).toBe(true);
    expect(types.has('class_definition')).toBe(true);
  });

  it('marks nested def as method', async () => {
    const parser = await loadParser('python');
    const syms = extractSymbols(pythonConfig, parser, SRC);
    const byName = Object.fromEntries(syms.map((s) => [s.name, s])) as Record<string, (typeof syms)[number]>;
    expect(byName.add!.kind).toBe('function');
    expect(byName.add!.isExported).toBe(true);
    expect(byName._private_fn).toMatchObject({ kind: 'function', isExported: false });
    expect(byName.Calc!.kind).toBe('class');
    expect(byName.mul!.kind).toBe('method');
    expect(byName.add!.startLine).toBe(1);
  });
});
