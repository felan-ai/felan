import { closeSync, constants, fsyncSync, openSync, renameSync } from 'node:fs';
import { requireOwnershipPlatform } from './native-ownership.js';

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

export function syncDirectory(path: string): void {
  if (requireOwnershipPlatform() === 'win32') return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { syncDescriptor(fd); } finally { closeSync(fd); }
}

export function replaceFile(source: string, target: string): void {
  if (requireOwnershipPlatform() !== 'win32') { renameSync(source, target); return; }
  const deadline = performance.now() + 2_000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { renameSync(source, target); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || performance.now() >= deadline) throw error;
      Atomics.wait(wait, 0, 0, Math.min(20, Math.max(0, deadline - performance.now())));
    }
  }
}
