import { describe, expect, it } from 'vitest';
import { ALL_TOOLS } from '../../src/tools/index.js';

describe('tool registry', () => {
  it('恰好 8 个 tool', () => {
    expect(ALL_TOOLS).toHaveLength(8);
  });

  it.each(ALL_TOOLS.map((t) => [t.name, t] as const))(
    '%s 拥有合法 schema 与 description',
    (_name, tool) => {
      expect(tool.name).toMatch(/^memory_/);
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.description).toMatch(/When to use:/);
      const schema = tool.inputSchema as { type?: string };
      expect(schema.type).toBe('object');
    },
  );

  it('tool 名字唯一', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
