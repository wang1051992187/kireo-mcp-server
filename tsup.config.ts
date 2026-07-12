import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string };

export default defineConfig({
  // web-tree-sitter and tree-sitter-wasms are in dependencies (not devDependencies),
  // so tsup auto-externalizes them — no explicit noExternal / external override needed.
  entry: { index: 'src/index.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  platform: 'node',
  shims: false,
  splitting: false,
  treeshake: true,
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
});
