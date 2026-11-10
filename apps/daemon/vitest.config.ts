import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration suites need a local Supabase stack (`pnpm test:integration`); perf suites run through `pnpm test:perf` at the root.
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts', '**/*.perf.test.ts'],
    // Test-only: skip fsync in the control store; spawned daemons inherit it. See src/daemon/durability.ts.
    env: { FELAN_TEST_SKIP_FSYNC: '1' },
  },
});
