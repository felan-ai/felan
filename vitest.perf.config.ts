import { defineConfig } from 'vitest/config';

// Wall-clock benchmarks and timing assertions. They are excluded from `pnpm test`
// because timing under a shared worker pool is not a reliable pass/fail signal.
export default defineConfig({
  test: {
    projects: ['apps/daemon', 'apps/felan', 'packages/session-protocol'].map((root) => ({
      test: {
        name: `${root}:perf`,
        root,
        include: ['test/**/*.perf.test.ts'],
      },
    })),
    maxWorkers: 1,
  },
});
