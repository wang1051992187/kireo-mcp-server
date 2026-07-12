import { describe, expect, it } from 'vitest';
import { extractSymbols } from '../../src/index/extractor.js';
import { loadParser } from '../../src/index/grammars.js';
import { typescriptConfig } from '../../src/index/languages/typescript.js';

const SRC = [
  '/** Adds two numbers. */',
  'export function add(a: number, b: number): number {',
  '  return a + b;',
  '}',
  '',
  'class Calc {',
  '  mul(a: number, b: number): number {',
  '    return a * b;',
  '  }',
  '}',
].join('\n');

describe('typescript extractor', () => {
  it('emits the node types we map (lock node-type strings)', async () => {
    const parser = await loadParser('typescript');
    const tree = parser.parse(SRC);
    const types = new Set<string>();
    const walk = (n: import('web-tree-sitter').SyntaxNode) => {
      types.add(n.type);
      for (let i = 0; i < n.childCount; i++) walk(n.child(i)!);
    };
    walk(tree!.rootNode);
    // These are the exact strings our config relies on:
    expect(types.has('function_declaration')).toBe(true);
    expect(types.has('class_declaration')).toBe(true);
    expect(types.has('method_definition')).toBe(true);
    expect(types.has('export_statement')).toBe(true);
  });

  it('extracts function, class, method with lines/signature/export', async () => {
    const parser = await loadParser('typescript');
    const syms = extractSymbols(typescriptConfig, parser, SRC);
    const byName = Object.fromEntries(syms.map((s) => [s.name, s])) as Record<string, (typeof syms)[number]>;

    expect(byName.add).toMatchObject({ kind: 'function', isExported: true, startLine: 2, endLine: 4 });
    expect(byName.add!.signature).toContain('export function add(a: number, b: number): number');
    expect(byName.add!.docstring).toContain('Adds two numbers');
    expect(byName.Calc).toMatchObject({ kind: 'class', isExported: false, startLine: 6 });
    expect(byName.mul).toMatchObject({ kind: 'method', isExported: false, startLine: 7 });
  });
});
