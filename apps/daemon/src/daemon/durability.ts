import { fsyncSync } from 'node:fs';

/**
 * Only the repository's Vitest configs set FELAN_TEST_SKIP_FSYNC=1, because macOS F_FULLFSYNC
 * dominates test time. Real daemons must leave it unset: skipping fsync can lose committed
 * control state on power loss or an OS crash.
 */
export function durableWrites(): boolean {
  return process.env.FELAN_TEST_SKIP_FSYNC !== '1';
}

export function syncDescriptor(fd: number): void {
  if (durableWrites()) fsyncSync(fd);
}
