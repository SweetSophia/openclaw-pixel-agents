import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    clearMocks: true,
    exclude: [...configDefaults.exclude, '**/dist/**', '.worktrees/**'],
    coverage: {
      include: ['src/**/*.{ts,tsx}', 'server/**/*.ts', 'shared/**/*.ts'],
      exclude: ['**/*.test.{ts,tsx}', 'src/test/**', 'src/vite-env.d.ts'],
      thresholds: {
        branches: 36,
        functions: 37,
        lines: 41,
        statements: 39,
      },
    },
  },
});
