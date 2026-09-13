import { describe, expect, it } from 'vitest';
import { ALL_TOOLS } from '../../src/tools/index.js';

/**
 * The three tool families this server exposes. Still an allowlist, not a
 * rubber stamp: a tool that does not belong to one of them is a bug.
 *
 * It was `/^memory_/` from when memory_* was everything; this branch adds
 * project_info / context_save / context_load, and the assertion was never
 * updated — `vitest run` (what README's `pnpm test` runs) has been red ever
 * since, while `test:unit` (tests/unit only) stayed green and hid it.
 */
const TOOL_NAME = /^(memory|context|project)_/;

describe('tool registry', () => {
  it('恰好 12 个 tool', () => {
    expect(ALL_TOOLS).toHaveLength(12);
  });

  it.each(ALL_TOOLS.map((t) => [t.name, t] as const))(
    '%s 拥有合法 schema 与 description',
    (_name, tool) => {
      expect(tool.name).toMatch(TOOL_NAME);
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
