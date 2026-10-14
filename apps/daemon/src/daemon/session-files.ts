import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { AbsolutePathSchema, IdSchema } from '@felan-ai/session-protocol';
import { Type } from 'typebox';
import type { DaemonOwnership } from './ownership.js';
import { guardOwnedPaths, prepareControlDirectory, syncOwnedDirectory } from './persistence.js';
import { assertPathIdentity, pathIdentity, pathInside, type PathIdentity } from './target.js';

export const sessionHeaderSchema = Type.Object({ type: Type.Literal('session'), version: Type.Integer({ minimum: 1, maximum: 3 }), id: IdSchema, cwd: AbsolutePathSchema });
const error = (code: string, message: string) => Object.assign(new Error(message), { code });
const absent = (cause: unknown) => (cause as NodeJS.ErrnoException).code === 'ENOENT';

function owned(owner: DaemonOwnership, path: string): string {
  if (owner.assertOwnsPath(path) !== path) throw error('ownership_lost', 'Owned file changed its canonical destination.');
  return path;
}
function regular(stat: BigIntStats, owner?: DaemonOwnership): void {
  if (!stat.isFile() || owner && (stat.uid !== BigInt(owner.target.uid) || stat.nlink !== 1n)) throw error('invalid_request', 'Expected an unchanged regular file with one owned link.');
}
function sameFile(stat: BigIntStats, pin: PathIdentity): void {
  if (stat.dev !== pin.dev || stat.ino !== pin.ino) throw error('ownership_lost', 'File identity changed.');
}
function unlinkPinned(path: string, pin: PathIdentity): void {
  try { assertPathIdentity(pin); unlinkSync(path); }
  catch (cause) { if (!absent(cause)) throw cause; }
}

export function prepareTranscriptDeletion(owner: DaemonOwnership, input: string): () => void {
  const path = owned(owner, input);
  return () => {
    owned(owner, path);
    try { unlinkSync(path); }
    catch (cause) { if (!absent(cause)) throw cause; return; }
    syncOwnedDirectory(owner, dirname(path));
  };
}

export function readOwnedOutputRange(owner: DaemonOwnership, input: string, offset: number, limit: number): Uint8Array {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 65536) throw error('invalid_request', 'Invalid output range.');
  const path = owned(owner, input); const check = guardOwnedPaths(owner, [path]); const pin = pathIdentity(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true }); regular(before, owner); sameFile(before, pin); check();
    if (BigInt(offset) > before.size) throw error('resync_required', 'Output range is no longer retained.');
    const bytes = Buffer.alloc(limit); const count = readSync(fd, bytes, 0, limit, offset);
    const after = fstatSync(fd, { bigint: true }); regular(after, owner); sameFile(after, pin);
    if (!Number.isSafeInteger(offset + count) || after.size < BigInt(offset + count)) throw error('resync_required', 'Output shrank during the read.');
    check(); return new Uint8Array(bytes.subarray(0, count));
  } finally { closeSync(fd); }
}

export interface PreparedImport { bytes: Buffer }
export interface StagedImport { path: string; dispose(): void }
export function prepareImport(owner: DaemonOwnership, source: string): PreparedImport {
  owner.assertCurrent();
  const bytes = readFileSync(source); const end = bytes.indexOf(10);
  let header: unknown;
  try { header = JSON.parse(bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8')); }
  catch { header = undefined; }
  if ((header as { type?: unknown } | undefined)?.type !== 'session') throw error('invalid_request', 'Import source is not a session transcript.');
  return { bytes };
}

export function stageImport(owner: DaemonOwnership, directory: string, source: string, prepared = prepareImport(owner, source)): StagedImport {
  owner.assertCurrent();
  const target = prepareControlDirectory(owner, join(owned(owner, directory), '.felan-import')); const check = guardOwnedPaths(owner, [target]);
  const path = join(target, `.felan-import-${randomUUID()}.tmp`);
  const output = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let pin: PathIdentity | undefined;
  try { pin = pathIdentity(path); check(); writeFileSync(output, prepared.bytes); fsyncSync(output); check(); }
  catch (cause) { owner.assertCurrent(); if (pin) unlinkPinned(path, pin); throw cause; }
  finally { closeSync(output); }
  const pinned = pin;
  const dispose = () => { check(); unlinkPinned(path, pinned); syncOwnedDirectory(owner, target); };
  try { syncOwnedDirectory(owner, target); return { path, dispose }; }
  catch (cause) { dispose(); throw cause; }
}

export interface PreparedExport { target: string }
/** Resolves an export destination; only daemon-managed files (transcripts, control and runtime state) are protected. */
export function prepareExport(owner: DaemonOwnership, destination: string, managed: readonly string[]): PreparedExport {
  owner.assertCurrent();
  if (['.', '..', ''].includes(basename(destination))) throw error('invalid_request', 'Export requires an explicit file name.');
  const target = join(realpathSync(dirname(destination)), basename(destination));
  let resolved = target;
  try { resolved = realpathSync(target); } catch (cause) { if (!absent(cause)) throw cause; }
  if (managed.some(path => pathInside(path, target) || pathInside(path, resolved))) throw error('forbidden', 'Export cannot overwrite files managed by the session daemon.');
  return { target };
}

export async function publishExport(owner: DaemonOwnership, render: (path: string) => Promise<unknown>, prepared: PreparedExport): Promise<string> {
  const { target } = prepared;
  const temp = join(dirname(target), `.felan-export-${randomUUID()}.tmp`);
  try {
    await render(temp);
    owner.assertCurrent();
    try { chmodSync(temp, statSync(target).mode & 0o777); } catch (cause) { if (!absent(cause)) throw cause; }
    const fd = openSync(temp, constants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, target);
  } catch (cause) {
    try { unlinkSync(temp); } catch {}
    throw cause;
  }
  const directory = openSync(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
  return target;
}
