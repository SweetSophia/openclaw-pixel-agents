import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    clearMocks: true,
    exclude: [...configDefaults.exclude, '**/dist/**', '.worktrees/**'],
    coverage: {
      thresholds: {
        branches: 40,
        functions: 40,
        lines: 40,
        statements: 40,
      },
    },
  },
});
