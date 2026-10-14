import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withLocalFileLock } from '@felan-ai/daemon/provider';

export type MutableDaemonGlobalSettings = Record<string, unknown>;

const pendingTransactions = new Map<string, Promise<void>>();

export async function readDaemonSettingsStore(
  agentDir: string,
  assertCurrent: () => void,
): Promise<MutableDaemonGlobalSettings> {
  return accessDaemonSettingsStore(agentDir, assertCurrent);
}

export async function updateDaemonSettingsStore(
  agentDir: string,
  assertCurrent: () => void,
  update: (settings: MutableDaemonGlobalSettings) => void,
): Promise<MutableDaemonGlobalSettings> {
  return accessDaemonSettingsStore(agentDir, assertCurrent, update);
}

async function accessDaemonSettingsStore(
  agentDir: string,
  assertCurrent: () => void,
  merge?: (settings: MutableDaemonGlobalSettings) => void,
): Promise<MutableDaemonGlobalSettings> {
  const previous = pendingTransactions.get(agentDir) ?? Promise.resolve();
  const transaction = previous.then(() => transactDaemonSettingsStore(agentDir, assertCurrent, merge));
  const settled = transaction.then(() => undefined, () => undefined);
  pendingTransactions.set(agentDir, settled);
  try { return await transaction; }
  finally { if (pendingTransactions.get(agentDir) === settled) pendingTransactions.delete(agentDir); }
}

async function transactDaemonSettingsStore(
  agentDir: string,
  assertCurrent: () => void,
  merge?: (settings: MutableDaemonGlobalSettings) => void,
): Promise<MutableDaemonGlobalSettings> {
  assertCurrent();
  await mkdir(agentDir, { recursive: true });
  // Writing through a symlinked settings.json keeps dotfile links intact.
  const path = await realpath(join(agentDir, 'settings.json')).catch((error: unknown) => {
    if (isMissingFile(error)) return join(agentDir, 'settings.json');
    throw error;
  });
  return withLocalFileLock(path, { realpath: false, retries: { retries: 10, minTimeout: 20, maxTimeout: 50 } }, async lock => {
    let settings: MutableDaemonGlobalSettings = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!isRecord(parsed)) throw new Error('settings.json must contain an object');
      settings = parsed;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    if (!merge) return settings;
    merge(settings);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      assertCurrent(); lock.throwIfCompromised();
      await rename(temporaryPath, path);
      assertCurrent(); lock.throwIfCompromised();
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
    return settings;
  });
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}

function isRecord(value: unknown): value is MutableDaemonGlobalSettings {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
