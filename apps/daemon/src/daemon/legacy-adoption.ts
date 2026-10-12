import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AbsolutePathSchema, IdSchema, parseSchema } from '@felan-ai/session-protocol';
import { Type } from 'typebox';
import type { DaemonOwnership } from './ownership.js';
import { assertPathIdentity, assertPrivateStat, pathIdentity, pathInside } from './target.js';
import { DaemonControlStore } from './control-store.js';
import { ControlStoreError, type ControlAdoption } from './control-state.js';
import { guardOwnedPaths, prepareControlDirectory, sha256 } from './persistence.js';

const maxLegacyBytes = 64 * 1024 * 1024;
const maxHeaderBytes = 64 * 1024;
export const LEGACY_WRITER_WARNING = 'Older Felan/Pi binaries do not cooperate with daemon locks. Stop all known writers and their descendants; detection cannot prove that an older binary is absent.';
const headerSchema = Type.Object({ type: Type.Literal('session'), version: Type.Integer({ minimum: 1, maximum: 3 }), id: IdSchema, cwd: AbsolutePathSchema });
export interface LegacySessionIdentity { session: string; cwd: string; source: string; fingerprint: string; bytes: number }

function readLegacy(owner: DaemonOwnership, source: string): { identity: LegacySessionIdentity; bytes: Buffer } {
  const path = owner.assertOwnsPath(source);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true }); const pin = pathIdentity(path);
    if (!stat.isFile() || stat.uid !== BigInt(owner.target.uid) || stat.nlink !== 1n || stat.size > BigInt(maxLegacyBytes) || stat.dev !== pin.dev || stat.ino !== pin.ino) throw new Error('unsafe source');
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const count = readSync(fd, buffer, length, Math.min(65536, buffer.byteLength - length), length);
      if (!count) break;
      length += count;
    }
    if (length > maxLegacyBytes) throw new Error('oversize');
    if (length !== Number(stat.size)) throw new Error('source changed');
    const bytes = buffer.subarray(0, length);
    const end = bytes.indexOf(10);
    if (end < 0 || end > maxHeaderBytes) throw new Error('header');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const lines = text.trimEnd().split('\n');
    const header = parseSchema(headerSchema, JSON.parse(lines[0]!));
    // Every copied row must remain parseable by Pi; the bytes themselves are never rewritten.
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const row: unknown = JSON.parse(line);
      if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid row');
    }
    const after = fstatSync(fd, { bigint: true });
    if (!after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino || after.uid !== stat.uid || after.nlink !== stat.nlink
      || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) throw new Error('source changed');
    assertPathIdentity(pin); owner.assertCurrent();
    return { bytes, identity: { session: header.id, cwd: header.cwd, source: path, fingerprint: sha256(bytes), bytes: bytes.length } };
  } catch {
    throw new ControlStoreError('adoption_required', 'Legacy source is unsafe, changed, unsupported or invalid; keep the original and inspect it before adoption.');
  } finally { closeSync(fd); }
}
export function inspectLegacySession(owner: DaemonOwnership, source: string): LegacySessionIdentity { return readLegacy(owner, source).identity; }

export interface LegacyAdoptionRequest {
  source: string;
  expectedFingerprint: string;
  expectedSession: string;
  expectedCwd: string;
  backupConfirmed: true;
  quiescenceConfirmed: true;
  warningAcknowledged: true;
}
export interface LegacyAdoptionOptions {
  managedDirectory: string;
  allSessionDirectories: readonly string[];
  checkKnownWriters: (source: LegacySessionIdentity) => Promise<'none_known' | 'live' | 'unknown'>;
}

export async function adoptLegacySession(store: DaemonControlStore, request: LegacyAdoptionRequest, options: LegacyAdoptionOptions): Promise<ControlAdoption> {
  const owner = store.owner;
  owner.assertCurrent();
  if (request.backupConfirmed !== true || request.quiescenceConfirmed !== true || request.warningAcknowledged !== true || options.allSessionDirectories.length === 0) throw new ControlStoreError('adoption_required', 'Explicit backup, writer quiescence, complete session-directory inventory and legacy warning acknowledgement are required.');
  const directory = owner.assertOwnsPath(options.managedDirectory);
  const scanInputs = [join(owner.target.agentDir, 'sessions'), ...options.allSessionDirectories];
  const scanned = [...new Set(scanInputs.map(path => owner.assertOwnsPath(path)))];
  const checkTargets = guardOwnedPaths(owner, [request.source, options.managedDirectory, ...scanInputs]);
  const checkExclusion = () => {
    checkTargets();
    if (scanned.some(path => pathInside(path, directory))) throw new ControlStoreError('adoption_required', 'Managed copies must be outside every Pi-scanned default/custom session directory.');
  };
  checkExclusion();
  const first = inspectLegacySession(owner, request.source);
  if (first.fingerprint !== request.expectedFingerprint || first.session !== request.expectedSession || first.cwd !== request.expectedCwd || !scanned.some(path => pathInside(path, first.source))) throw new ControlStoreError('request_conflict', 'Selected legacy source, session or cwd changed.');
  const existing = store.snapshot().adoptions.find(item => item.session === first.session);
  if (existing && (existing.source !== first.source || existing.fingerprint !== first.fingerprint || existing.cwd !== first.cwd)) throw new ControlStoreError('request_conflict', 'Session was adopted from another source identity.');
  const status = await options.checkKnownWriters(first);
  checkExclusion();
  if (status !== 'none_known') throw new ControlStoreError('adoption_required', 'A known live or uncertain legacy writer blocks adoption. Stop it explicitly; never force takeover.');
  const verified = readLegacy(owner, first.source);
  if (verified.identity.fingerprint !== first.fingerprint) throw new ControlStoreError('request_conflict', 'Legacy source changed during writer checks.');
  if (prepareControlDirectory(owner, directory) !== directory) throw new ControlStoreError('ownership_lost', 'Managed directory changed.');
  checkExclusion();
  const checkDirectory = guardOwnedPaths(owner, [directory]);
  const unwatch = owner.watchPath(directory);
  try {
    const destination = owner.assertOwnsPath(join(directory, `${sha256(first.session)}.jsonl`));
    if (existing && existing.destination !== destination) throw new ControlStoreError('request_conflict', 'Managed destination changed.');
    const adoption: ControlAdoption = existing ?? { id: randomUUID(), session: first.session, source: first.source, destination, fingerprint: first.fingerprint, cwd: first.cwd, createdAt: Date.now(), phase: 'copy_intent' };
    if (!existing) store.recordAdoption(adoption);
    let present = false;
    try {
      lstatSync(destination); present = true;
      const managed = readLegacy(owner, destination).identity;
      if (managed.session !== first.session || managed.cwd !== first.cwd || (adoption.phase !== 'complete' && managed.fingerprint !== first.fingerprint)) throw new ControlStoreError('request_conflict', 'Managed copy differs from the adoption intent.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing?.phase === 'complete' && !present) throw new ControlStoreError('storage_failure', 'Completed adopted copy is missing; restore explicitly, never recreate it.');
    if (!present) {
      const temp = join(directory, `.adoption-${randomUUID()}.tmp`);
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, verified.bytes); fsyncSync(fd); } finally { closeSync(fd); }
      try {
        checkExclusion(); checkDirectory();
        // An exclusive link never replaces a previously managed transcript.
        linkSync(temp, destination); unlinkSync(temp);
      } finally { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    }
    const checkCopy = guardOwnedPaths(owner, [destination]);
    const finalStatus = await options.checkKnownWriters(first);
    checkExclusion(); checkDirectory(); checkCopy();
    if (finalStatus !== 'none_known' || inspectLegacySession(owner, first.source).fingerprint !== first.fingerprint) throw new ControlStoreError('adoption_required', 'Legacy writer state or source changed; the copy remains staged, not executable.');
    const managed = readLegacy(owner, destination).identity;
    if (managed.session !== first.session || managed.cwd !== first.cwd || (adoption.phase !== 'complete' && managed.fingerprint !== first.fingerprint)) throw new ControlStoreError('request_conflict', 'Managed copy changed before adoption completion.');
    const fd = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd, { bigint: true }); const pin = pathIdentity(destination);
      assertPrivateStat(stat, owner.target.uid, false);
      if (stat.dev !== pin.dev || stat.ino !== pin.ino) throw new ControlStoreError('ownership_lost', 'Managed file changed while syncing.');
      checkCopy(); fsyncSync(fd); checkCopy();
    } finally { closeSync(fd); }
    prepareControlDirectory(owner, directory);
    checkExclusion(); checkDirectory(); checkCopy();
    return store.recordAdoption({ ...adoption, phase: 'complete' }).value;
  } finally { unwatch(); }
}
