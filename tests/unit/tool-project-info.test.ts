import { describe, expect, it, vi } from 'vitest';

import { projectInfoTool } from '../../src/tools/project-info.js';

const ctx = { rest: {} as never, logger: { info: vi.fn(), warn: vi.fn() } as never };

describe('project_info tool', () => {
  it('reports key, source, and both namespaces', async () => {
    const res = await projectInfoTool.handler({ cwd: process.cwd() }, ctx);
    const text = res.content.map((c) => (c as { text: string }).text).join('');
    expect(text).toMatch(/ctx-/);
    expect(text).toMatch(/code-/);
    expect(text).toMatch(/source/);
  });

  it('derives namespaces that satisfy NAMESPACE_REGEX', async () => {
    const res = await projectInfoTool.handler({ cwd: process.cwd() }, ctx);
    const text = res.content.map((c) => (c as { text: string }).text).join('');
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as {
      ctx_namespace: string;
      code_namespace: string;
    };
    for (const ns of [parsed.ctx_namespace, parsed.code_namespace]) {
      expect(ns).toMatch(/^[a-z0-9_-]{1,32}$/);
    }
  });
});
