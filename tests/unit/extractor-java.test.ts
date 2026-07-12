import { describe, expect, it } from 'vitest';
import { extractSymbols } from '../../src/index/extractor.js';
import { loadParser } from '../../src/index/grammars.js';
import { javaConfig } from '../../src/index/languages/java.js';

const SRC = [
  'public class Calc {',
  '  public int add(int a, int b) { return a + b; }',
  '  private int mul(int a, int b) { return a * b; }',
  '}',
].join('\n');

describe('java extractor', () => {
  it('locks node types', async () => {
    const parser = await loadParser('java');
    const tree = parser.parse(SRC);
    const types = new Set<string>();
    const walk = (n: import('web-tree-sitter').SyntaxNode) => {
      types.add(n.type);
      for (let i = 0; i < n.childCount; i++) walk(n.child(i)!);
    };
    walk(tree!.rootNode);
    expect(types.has('class_declaration')).toBe(true);
    expect(types.has('method_declaration')).toBe(true);
  });

  it('uses public/private modifier for export flag', async () => {
    const parser = await loadParser('java');
    const syms = extractSymbols(javaConfig, parser, SRC);
    const byName = Object.fromEntries(syms.map((s) => [s.name, s])) as Record<string, (typeof syms)[number]>;
    expect(byName.Calc).toMatchObject({ kind: 'class', isExported: true });
    expect(byName.add).toMatchObject({ kind: 'method', isExported: true });
    expect(byName.mul!.isExported).toBe(false);
  });
});
