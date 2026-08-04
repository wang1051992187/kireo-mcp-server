import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 与 tsconfig.json 的 paths 一一对应，必须指向同一个文件。
  // tsconfig 的 paths 只管类型检查（tsc）和 tsup 的打包解析，Vite/Vitest 的运行时模块
  // 解析不读它，所以测试要跑起来得在这里再声明一次。src/ 里对 @kireo/shared 是裸
  // import，而镜像没有 pnpm workspace，只有同步脚本 vendor 过来的 vendor/shared/。
  // 改一处就要改另一处，否则 tsc 过了测试仍然会 "Cannot find module '@kireo/shared'"。
  resolve: {
    alias: {
      '@kireo/shared': fileURLToPath(new URL('./vendor/shared/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    pool: 'forks',
    testTimeout: 10_000,
    hookTimeout: 10_000,
    setupFiles: ['./tests/helpers/setup-msw.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
      exclude: ['**/dist/**', '**/tests/helpers/**', '**/*.d.ts'],
    },
    include: ['tests/**/*.test.ts'],
  },
});
