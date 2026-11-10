import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.perf.test.ts'],
    testTimeout: 30_000,
    // Test-only: skip fsync in daemon stores used by client tests; see apps/daemon/src/daemon/durability.ts.
    env: { FELAN_TEST_SKIP_FSYNC: '1' },
  },
});
