import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,mjs}'],
    setupFiles: ['test/setup.ts'],
    pool: 'forks',
    isolate: true,
    testTimeout: 10000,
  },
});
