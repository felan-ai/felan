import { beforeEach, expect, it, vi } from 'vitest';

const lock = vi.hoisted(() => {
  vi.resetModules();
  return vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>();
});
vi.mock('@felan-ai/daemon/provider', () => ({ withLocalFileLock: lock }));
vi.mock('node:fs/promises', () => ({
  mkdir: async () => undefined,
  realpath: async (path: string) => path,
  readFile: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), rm: vi.fn(),
}));

import { readDaemonSettingsStore, updateDaemonSettingsStore } from '../src/providers/settings-store.js';

beforeEach(() => { lock.mockReset(); lock.mockResolvedValue({}); });

function deferred() {
  let resolve!: (value: Record<string, unknown>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Record<string, unknown>>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function holdLock() {
  const held = deferred();
  const entered = deferred();
  lock.mockImplementationOnce(() => { entered.resolve({}); return held.promise; });
  return { ...held, entered: entered.promise };
}

it('queues reads and writes before attempting a contended local file lock', async () => {
  const held = holdLock();
  const owner = vi.fn();
  const first = updateDaemonSettingsStore('/settings-queue', owner, () => {});
  await held.entered;
  const second = readDaemonSettingsStore('/settings-queue', owner);
  const third = updateDaemonSettingsStore('/settings-queue', owner, () => {});
  try {
    await Promise.resolve();
    expect(lock).toHaveBeenCalledOnce();
    expect(owner).toHaveBeenCalledOnce();
  } finally { held.resolve({}); await Promise.all([first, second, third]); }
  expect(lock).toHaveBeenCalledTimes(3);
  expect(owner).toHaveBeenCalledTimes(3);
});

it('does not block a different canonical settings directory', async () => {
  const held = holdLock();
  const first = readDaemonSettingsStore('/settings-first', () => {});
  await held.entered;
  try {
    expect(await readDaemonSettingsStore('/settings-second', () => {})).toEqual({});
    expect(lock).toHaveBeenCalledTimes(2);
  } finally { held.resolve({}); await first; }
});

it('continues queued transactions after a failed lock attempt', async () => {
  const held = holdLock();
  const failure = new Error('External lock is held');
  const first = readDaemonSettingsStore('/settings-failed', () => {}).catch(error => error);
  const second = updateDaemonSettingsStore('/settings-failed', () => {}, () => {});
  await held.entered;
  held.reject(failure);
  expect(await first).toBe(failure);
  expect(await second).toEqual({});
  expect(await readDaemonSettingsStore('/settings-failed', () => {})).toEqual({});
  expect(lock).toHaveBeenCalledTimes(3);
});
