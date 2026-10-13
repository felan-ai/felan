import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { withLocalFileLock } from '@felan-ai/daemon/provider';

export type MutableDaemonGlobalSettings = Record<string, unknown>;

const MAX_DAEMON_SETTINGS_BYTES = 1024 * 1024;
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
  if (resolve(agentDir) !== agentDir || await realpath(agentDir) !== agentDir) throw new Error('Daemon settings directory must be canonical.');
  const directory = await lstat(agentDir);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o022)) throw new Error('Unsafe daemon settings directory.');
  const path = join(agentDir, 'settings.json');
  return withLocalFileLock(path, { realpath: false, retries: { retries: 10, minTimeout: 20, maxTimeout: 50 } }, async lock => {
    const check = async () => {
      assertCurrent(); lock.throwIfCompromised();
      if (!(await lock.isCurrent())) throw new Error('Daemon settings lock was replaced.');
      const current = await lstat(agentDir);
      if (!sameFile(current, directory) || current.uid !== directory.uid || (current.mode & 0o022) || await realpath(agentDir) !== agentDir) throw new Error('Daemon settings directory was replaced.');
      assertCurrent(); lock.throwIfCompromised();
    };
    await check();
    let original: Stats | undefined; let settings: MutableDaemonGlobalSettings = {};
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      original = await file.stat();
      if (!original.isFile() || original.nlink !== 1 || original.uid !== directory.uid) throw new Error('Unsafe daemon settings file.');
      const data = Buffer.alloc(MAX_DAEMON_SETTINGS_BYTES + 1); let length = 0;
      while (length < data.byteLength) {
        const read = await file.read(data, length, data.byteLength - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > MAX_DAEMON_SETTINGS_BYTES) throw new Error('Daemon settings byte limit exceeded.');
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, length)));
      if (!isRecord(parsed)) throw new Error('settings.json must contain an object');
      settings = parsed;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    } finally { await file?.close(); }
    await check();
    if (!merge) return settings;
    merge(settings);
    const data = `${JSON.stringify(settings, null, 2)}\n`;
    if (Buffer.byteLength(data) > MAX_DAEMON_SETTINGS_BYTES) throw new Error('Daemon settings byte limit exceeded.');
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    let temporary: Stats | undefined;
    try {
      const target = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { temporary = await target.stat(); await target.writeFile(data); await target.sync(); } finally { await target.close(); }
      await check();
      let current: Stats | undefined;
      try { current = await lstat(path); } catch (error) { if (!isMissingFile(error)) throw error; }
      if (original ? !current || !sameFile(original, current) || original.size !== current.size || original.mtimeMs !== current.mtimeMs : current !== undefined) throw new Error('Daemon settings file changed during update.');
      if (!sameFile(await lstat(temporaryPath), temporary)) throw new Error('Daemon settings temporary file was replaced.');
      assertCurrent(); lock.throwIfCompromised();
      await rename(temporaryPath, path);
      await check();
      if (!sameFile(await lstat(path), temporary)) throw new Error('Daemon settings commit was replaced.');
      const handle = await open(agentDir, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
      await check();
      return settings;
    } finally {
      if (temporary) {
        const current = await lstat(temporaryPath).catch(() => undefined);
        if (current && sameFile(current, temporary)) await rm(temporaryPath, { force: true });
      }
    }
  });
}

function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}

function isRecord(value: unknown): value is MutableDaemonGlobalSettings {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
