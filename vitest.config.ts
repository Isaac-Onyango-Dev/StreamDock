import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['**/*.test.ts', '**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // `electron/**` used to be excluded, while 10 of the 15 test files test
      // exactly that directory — so the reported figure omitted most of what is
      // actually covered and moved for reasons unrelated to test quality.
      //
      // The suites themselves are excluded too: a test file always reports ~100%
      // of itself, and `tests/e2e/*.spec.ts` is run by Playwright, not Vitest, so
      // it always reported 0%. Both were distorting the total in opposite
      // directions.
      exclude: [
        'node_modules/**',
        'dist/**',
        'dist-electron/**',
        'scripts/**',
        'tests/**',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.spec.ts',
        '**/*.d.ts',
        '**/*.config.*',
        '**/main.tsx',
        '**/App.tsx',
      ],
    },
    setupFiles: ['./tests/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './client/src'),
      '@electron': path.resolve(__dirname, './electron'),
    },
  },
});