import { defineConfig } from 'vitest/config';

export default defineConfig({
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
