import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration suites need a local Supabase stack (`pnpm test:integration`); perf suites run through `pnpm test:perf` at the root.
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts', '**/*.perf.test.ts'],
  },
});
