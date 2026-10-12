import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { AbsolutePathSchema, IdSchema, parseSchema } from '@felan-ai/session-protocol';
import { Type, type Static } from 'typebox';
import type { DaemonOwnership } from './ownership.js';
import type { LegacySessionIdentity } from './legacy-adoption.js';
import { guardOwnedPaths, prepareControlDirectory, syncOwnedDirectory } from './persistence.js';
import { assertPathIdentity, pathIdentity, pathInside, pinPathChain, type PathIdentity } from './target.js';

const maxImportBytes = 64 * 1024 * 1024;
const headerSchema = Type.Object({ type: Type.Literal('session'), version: Type.Integer({ minimum: 1, maximum: 3 }), id: IdSchema, cwd: AbsolutePathSchema });
const error = (code: string, message: string) => Object.assign(new Error(message), { code });
const absent = (cause: unknown) => (cause as NodeJS.ErrnoException).code === 'ENOENT';

export interface CachedLegacyIdentity { key: string; identity: LegacySessionIdentity }
export type InventorySessionIdentity = Omit<LegacySessionIdentity, 'fingerprint' | 'bytes'> & { fingerprint?: string; bytes?: number };
export interface InventoryHeader { key: string; identity: InventorySessionIdentity; verifiable: boolean; diagnostic?: 'unreadable' | 'oversize' }

export async function inspectInventoryHeader(owner: DaemonOwnership, input: string, cached?: CachedLegacyIdentity): Promise<InventoryHeader> {
  const path = owned(owner, input); const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat({ bigint: true }); regular(stat); const pin = pathIdentity(path); sameFile(stat, pin);
    const key = inventoryKey(stat);
    if (cached?.key === key) { assertPathIdentity(pin); owner.assertCurrent(); return { key, identity: { ...cached.identity }, verifiable: true }; }
    const buffer = Buffer.alloc(65537); let length = 0; let end = -1;
    while (length < buffer.length && end < 0) {
      const { bytesRead } = await file.read(buffer, length, Math.min(4096, buffer.length - length), length);
      if (!bytesRead) break;
      end = buffer.subarray(0, length + bytesRead).indexOf(10, length); length += bytesRead; owner.assertCurrent();
    }
    if (end < 0 || end > 65536) throw error('invalid_request', 'Legacy header exceeds its limit or has no terminating newline.');
    const header = parseSchema(headerSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end))));
    if (inventoryKey(await file.stat({ bigint: true })) !== key) throw error('invalid_request', 'Legacy source changed during header inspection.');
    assertPathIdentity(pin); owner.assertCurrent();
    const diagnostic = stat.uid !== BigInt(owner.target.uid) || stat.nlink !== 1n ? 'unreadable'
      : stat.size > BigInt(maxImportBytes) ? 'oversize' : undefined;
    return { key, identity: { session: header.id, cwd: header.cwd, source: path, ...(Number.isSafeInteger(Number(stat.size)) ? { bytes: Number(stat.size) } : {}) },
      verifiable: diagnostic === undefined, ...(diagnostic ? { diagnostic } : {}) };
  } finally { await file.close(); }
}

function inventoryKey(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.nlink].join(':');
}

export async function inspectInventorySource(owner: DaemonOwnership, input: string, cached?: CachedLegacyIdentity, readBudget = maxImportBytes,
  readBytes?: (bytes: number) => void): Promise<CachedLegacyIdentity> {
  const path = owned(owner, input); const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat({ bigint: true }); regular(stat, owner); const pin = pathIdentity(path); sameFile(stat, pin);
    if (stat.size > BigInt(maxImportBytes)) throw error('oversize', 'Legacy transcript exceeds the inventory read limit.');
    const key = inventoryKey(stat);
    if (cached?.key === key) { assertPathIdentity(pin); owner.assertCurrent(); return cached; }
    if (!Number.isSafeInteger(readBudget) || readBudget < 0 || stat.size > BigInt(readBudget)) throw error('inventory_budget', 'Inventory content-read budget reached.');
    const hash = createHash('sha256'); const buffer = Buffer.alloc(65536); const decoder = new TextDecoder('utf-8', { fatal: true });
    let count = 0; const pending: string[] = []; let pendingBytes = 0; let header: Static<typeof headerSchema> | undefined; let rows = 0;
    const line = (text: string) => {
      if (!header) { if (Buffer.byteLength(text) > 65536) throw error('invalid_request', 'Legacy header exceeds its limit.'); header = parseSchema(headerSchema, JSON.parse(text)); }
      else if (text.trim()) { const row: unknown = JSON.parse(text); if (!row || typeof row !== 'object' || Array.isArray(row)) throw error('invalid_request', 'Invalid legacy row.'); }
    };
    const consume = async (text: string) => {
      const parts = text.split('\n');
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index]!; pending.push(part); pendingBytes += Buffer.byteLength(part);
        if (!header && pendingBytes > 65536) throw error('invalid_request', 'Legacy header exceeds its limit.');
        if (index < parts.length - 1) {
          line(pending.join('')); pending.length = 0; pendingBytes = 0;
          if (++rows % 64 === 0) await yieldTurn();
        }
      }
    };
    while (count <= Number(stat.size)) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, Number(stat.size) + 1 - count), count);
      if (!bytesRead) break;
      readBytes?.(bytesRead);
      count += bytesRead; if (count > Number(stat.size)) throw error('invalid_request', 'Legacy source grew during inventory.');
      const chunk = buffer.subarray(0, bytesRead); hash.update(chunk); await consume(decoder.decode(chunk, { stream: true }));
      owner.assertCurrent();
    }
    await consume(decoder.decode());
    if (!header) throw error('invalid_request', 'Legacy header has no terminating newline.');
    const last = pending.join(''); if (last.trim()) line(last);
    if (!header || count !== Number(stat.size)) throw error('invalid_request', 'Incomplete legacy source.');
    const after = await file.stat({ bigint: true });
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) throw error('invalid_request', 'Legacy source changed during inventory.');
    assertPathIdentity(pin); owner.assertCurrent();
    return { key, identity: { session: header.id, cwd: header.cwd, source: path, bytes: count, fingerprint: hash.digest('hex') } };
  } finally { await file.close(); }
}

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
