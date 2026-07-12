import { describe, expect, it } from 'vitest';
import { extractSymbols } from '../../src/index/extractor.js';
import { loadParser } from '../../src/index/grammars.js';
import { goConfig } from '../../src/index/languages/go.js';

const SRC = [
  'package main',
  '',
  'func Add(a int, b int) int { return a + b }',
  '',
  'type Calc struct{ n int }',
  '',
  'func (c Calc) Mul(a int) int { return a * c.n }',
].join('\n');

describe('go extractor', () => {
  it('locks node types', async () => {
    const parser = await loadParser('go');
    const tree = parser.parse(SRC);
    const types = new Set<string>();
    const walk = (n: import('web-tree-sitter').SyntaxNode) => {
      types.add(n.type);
      for (let i = 0; i < n.childCount; i++) walk(n.child(i)!);
    };
    walk(tree!.rootNode);
    expect(types.has('function_declaration')).toBe(true);
    expect(types.has('method_declaration')).toBe(true);
    expect(types.has('type_declaration')).toBe(true);
  });

  it('extracts func/type/method and exported flag from capitalization', async () => {
    const parser = await loadParser('go');
    const syms = extractSymbols(goConfig, parser, SRC);
    const byName = Object.fromEntries(syms.map((s) => [s.name, s])) as Record<string, (typeof syms)[number]>;
    expect(byName.Add).toMatchObject({ kind: 'function', isExported: true });
    expect(byName.Calc).toMatchObject({ kind: 'class', isExported: true });
    expect(byName.Mul!.kind).toBe('method');
  });
});
