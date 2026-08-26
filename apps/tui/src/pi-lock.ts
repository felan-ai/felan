import { createRequire } from 'node:module';
import { acquireLocalFileLock, type LocalFileLockOptions } from './lock.js';

interface PiLockOptions extends LocalFileLockOptions {
  readonly fs?: unknown;
  readonly onCompromised?: (error: Error) => void;
}

interface PiLockfileModule {
  lock(path: string, options?: PiLockOptions): Promise<() => Promise<void>>;
}

const guardMarker = Symbol.for('@felan-ai/felan/pi-async-lock-guard');

export function installPiAsyncFileLockGuard(): void {
  // Patch Pi's exact CJS dependency instance so its already-imported auth and model stores see the guarded async lock.
  const piRequire = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const lockfile = piRequire('proper-lockfile') as PiLockfileModule;
  if (Reflect.get(lockfile, guardMarker) === true) return;

  lockfile.lock = async (path, options = {}) => {
    if (options.fs !== undefined) throw new Error('Felan does not support a custom filesystem for Pi file locks');
    const lock = await acquireLocalFileLock(path, options);
    if (options.onCompromised) {
      lock.compromised.addEventListener('abort', () => {
        const reason = lock.compromised.reason;
        options.onCompromised!(reason instanceof Error ? reason : new Error('Pi file lock was compromised'));
      }, { once: true });
    }
    return () => lock.release();
  };
  Reflect.set(lockfile, guardMarker, true);
}
