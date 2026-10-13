import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { AbsolutePathSchema, IdSchema, parseSchema } from '@felan-ai/session-protocol';
import { Type } from 'typebox';
import type { DaemonOwnership } from './ownership.js';
import { guardOwnedPaths, prepareControlDirectory, syncOwnedDirectory } from './persistence.js';
import { assertPathIdentity, pathIdentity, pathInside, pinPathChain, type PathIdentity } from './target.js';

const maxImportBytes = 64 * 1024 * 1024;
const headerSchema = Type.Object({ type: Type.Literal('session'), version: Type.Integer({ minimum: 1, maximum: 3 }), id: IdSchema, cwd: AbsolutePathSchema });
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
  const path = owned(owner, input); const directory = dirname(path);
  const check = guardOwnedPaths(owner, [directory]);
  let pin: PathIdentity | undefined;
  try { regular(lstatSync(path, { bigint: true }), owner); pin = pathIdentity(path); }
  catch (cause) { if (!absent(cause)) throw cause; }
  return () => {
    check(); owned(owner, path);
    if (pin) { assertPathIdentity(pin); unlinkSync(path); }
    else {
      try { lstatSync(path); throw error('ownership_lost', 'A transcript appeared after deletion preparation.'); }
      catch (cause) { if (!absent(cause)) throw cause; }
    }
    check(); if (pin) syncOwnedDirectory(owner, directory); check();
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

export interface PreparedImport { bytes: Buffer; assertCurrent(): void }
export interface StagedImport { path: string; dispose(): void }
export function prepareImport(owner: DaemonOwnership, source: string, excluded: readonly string[]): PreparedImport {
  owner.assertCurrent();
  const canonical = realpathSync(source);
  if (excluded.some(path => pathInside(path, canonical))) throw error('invalid_request', 'Managed transcripts must use clone, not import.');
  const fd = openSync(source, constants.O_RDONLY | constants.O_NONBLOCK);
  let bytes: Buffer; let checked: BigIntStats;
  try {
    const before = fstatSync(fd, { bigint: true }); regular(before);
    const current = statSync(canonical, { bigint: true });
    if (current.dev !== before.dev || current.ino !== before.ino || realpathSync(source) !== canonical) throw error('invalid_request', 'Import source changed.');
    if (before.size > BigInt(maxImportBytes)) throw error('invalid_request', 'Import exceeds 64 MiB.');
    const buffer = Buffer.alloc(Number(before.size) + 1); let count = 0;
    while (count < buffer.length) {
      const read = readSync(fd, buffer, count, Math.min(65536, buffer.length - count), count);
      if (!read) break;
      count += read;
    }
    const after = fstatSync(fd, { bigint: true });
    if (count !== Number(before.size) || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw error('invalid_request', 'Import source changed.');
    bytes = buffer.subarray(0, count);
    const end = bytes.indexOf(10);
    if (end < 0 || end > 65536) throw error('invalid_request', 'Import header exceeds its bound.');
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trimEnd().split('\n');
    parseSchema(headerSchema, JSON.parse(lines[0]!));
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw error('invalid_request', 'Invalid import row.');
    }
    owner.assertCurrent();
    checked = after;
  } finally { closeSync(fd); }
  const pin = pathIdentity(canonical);
  return { bytes, assertCurrent() {
    owner.assertCurrent(); assertPathIdentity(pin);
    const current = statSync(canonical, { bigint: true });
    if (realpathSync(source) !== canonical || current.dev !== checked.dev || current.ino !== checked.ino || current.size !== checked.size
      || current.mtimeNs !== checked.mtimeNs || current.ctimeNs !== checked.ctimeNs) throw error('invalid_request', 'Import source changed after validation.');
  } };
}

export function stageImport(owner: DaemonOwnership, directory: string, source: string, excluded: readonly string[], prepared = prepareImport(owner, source, excluded)): StagedImport {
  prepared.assertCurrent();
  const target = prepareControlDirectory(owner, join(owned(owner, directory), '.felan-import')); const check = guardOwnedPaths(owner, [target]);
  const path = join(target, `.felan-import-${randomUUID()}.tmp`);
  const output = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let pin: PathIdentity | undefined;
  try { pin = pathIdentity(path); check(); prepared.assertCurrent(); writeFileSync(output, prepared.bytes); fsyncSync(output); check(); prepared.assertCurrent(); }
  catch (cause) { owner.assertCurrent(); if (pin) unlinkPinned(path, pin); throw cause; }
  finally { closeSync(output); }
  const pinned = pin;
  const dispose = () => { check(); unlinkPinned(path, pinned); syncOwnedDirectory(owner, target); };
  try { syncOwnedDirectory(owner, target); return { path, dispose }; }
  catch (cause) { dispose(); throw cause; }
}

export interface PreparedExport { target: string; parent: string; parentPin: PathIdentity; previous?: PathIdentity; check(): void; checkParent(): void }
export function prepareExport(owner: DaemonOwnership, destination: string): PreparedExport {
  owner.assertCurrent();
  if (['.', '..', ''].includes(basename(destination))) throw error('invalid_request', 'Export requires an explicit file name.');
  const parent = realpathSync(dirname(destination)); const target = join(parent, basename(destination));
  if (owner.target.rootSet.some(root => pathInside(root, target))) throw error('forbidden', 'Export destinations cannot be inside a managed store.');
  const parents = pinPathChain(parent, owner.target.uid);
  const checkParent = () => { owner.assertCurrent(); for (const pin of parents) assertPathIdentity(pin); };
  let previous: PathIdentity | undefined;
  try { regular(lstatSync(target, { bigint: true }), owner); previous = pathIdentity(target); }
  catch (cause) { if (!absent(cause)) throw cause; }
  const checkDestination = () => {
    checkParent();
    if (previous) assertPathIdentity(previous);
    else {
      try { lstatSync(target); throw error('ownership_lost', 'Export destination appeared before publication.'); }
      catch (cause) { if (!absent(cause)) throw cause; }
    }
  };
  checkDestination();
  return { target, parent, parentPin: parents[0]!, ...(previous ? { previous } : {}), check: checkDestination, checkParent };
}

export async function publishExport(owner: DaemonOwnership, storageRoot: string, destination: string, render: (path: string) => Promise<unknown>, prepared = prepareExport(owner, destination)): Promise<string> {
  const { target, parent, parentPin, previous, check: checkDestination, checkParent } = prepared;
  if (target !== join(realpathSync(dirname(destination)), basename(destination))) throw error('invalid_request', 'Export destination differs from preparation.');
  checkDestination();
  const stageDir = prepareControlDirectory(owner, join(owned(owner, storageRoot), 'exports'));
  const checkStage = guardOwnedPaths(owner, [stageDir]); const stage = join(stageDir, `.staging-${randomUUID()}.tmp`);
  const stageFd = openSync(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  closeSync(stageFd); const stagePin = pathIdentity(stage);
  const temp = join(parent, `.felan-export-${randomUUID()}.tmp`);
  let tempPin: PathIdentity | undefined; let published = false;
  try {
    checkDestination(); await render(stage); checkStage(); assertPathIdentity(stagePin); checkDestination();
    const input = openSync(stage, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(input, { bigint: true }); regular(before, owner); sameFile(before, stagePin);
      const output = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
      try {
        tempPin = pathIdentity(temp);
        if (previous) { fchmodSync(output, Number(previous.mode & 0o777n)); tempPin = pathIdentity(temp); }
        const buffer = Buffer.alloc(65536); let offset = 0;
        while (BigInt(offset) < before.size) {
          const count = readSync(input, buffer, 0, Math.min(buffer.length, Number(before.size - BigInt(offset))), offset);
          if (!count) throw error('invalid_request', 'Export staging shrank during publication.');
          writeFileSync(output, buffer.subarray(0, count)); offset += count;
        }
        const after = fstatSync(input, { bigint: true });
        if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw error('invalid_request', 'Export staging changed during publication.');
        fsyncSync(output); checkStage(); checkDestination(); assertPathIdentity(tempPin);
        renameSync(temp, target); published = true;
      } finally { closeSync(output); }
    } finally { closeSync(input); }
    const directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { sameFile(fstatSync(directory, { bigint: true }), parentPin); checkParent(); fsyncSync(directory); checkParent(); }
    finally { closeSync(directory); }
    return target;
  } catch (cause) {
    if (published) throw error('indeterminate', 'Export was published but its durability could not be confirmed.');
    throw cause;
  } finally {
    try {
      owner.assertCurrent(); checkStage(); unlinkPinned(stage, stagePin); syncOwnedDirectory(owner, stageDir);
      if (tempPin && !published) { checkParent(); unlinkPinned(temp, tempPin); }
    } catch (cause) {
      if (published) throw error('indeterminate', 'Export was published but staging cleanup could not be confirmed.');
      throw cause;
    }
  }
}
