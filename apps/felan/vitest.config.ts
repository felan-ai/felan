import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.perf.test.ts'],
    testTimeout: 30_000,
  },
});
