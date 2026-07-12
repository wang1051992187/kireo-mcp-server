import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type GrammarName, grammarWasmPath, loadParser } from '../../src/index/grammars.js';

const ALL: GrammarName[] = ['typescript', 'tsx', 'javascript', 'python', 'go', 'java'];

describe('grammar resolution', () => {
  it('resolves an existing .wasm file for every grammar', () => {
    for (const g of ALL) {
      const p = grammarWasmPath(g);
      expect(p.endsWith(`tree-sitter-${g}.wasm`)).toBe(true);
      expect(existsSync(p)).toBe(true);
    }
  });

  it('loads a parser that parses source into a non-null tree', async () => {
    const parser = await loadParser('typescript');
    const tree = parser.parse('export function add(a: number, b: number) { return a + b; }');
    expect(tree?.rootNode.type).toBe('program');
  });
});
