import { join, resolve } from 'node:path';
import { LocalMemoryCoordinator, type LocalMemoryCoordinatorOptions } from './coordinator.js';

export interface SharedLocalMemoryCoordinator {
  readonly coordinator: LocalMemoryCoordinator;
  release(): Promise<void>;
}

const coordinators = new Map<string, { coordinator: LocalMemoryCoordinator; references: number }>();

export function acquireSharedLocalMemoryCoordinator(options: LocalMemoryCoordinatorOptions): SharedLocalMemoryCoordinator {
  const key = `${resolve(options.agentDir)}\0${resolve(options.sessionDir ?? join(options.agentDir, 'sessions'))}`;
  let shared = coordinators.get(key);
  if (!shared) {
    shared = { coordinator: new LocalMemoryCoordinator(options), references: 0 };
    coordinators.set(key, shared);
  }
  const entry = shared;
  entry.references += 1;
  let released: Promise<void> | undefined;
  return {
    coordinator: entry.coordinator,
    release() {
      released ??= release();
      return released;
    },
  };

  async function release(): Promise<void> {
    entry.references -= 1;
    if (entry.references !== 0) return;
    if (coordinators.get(key) === entry) coordinators.delete(key);
    await entry.coordinator.dispose();
  }
}
