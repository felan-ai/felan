import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DaemonOwnership } from './ownership.js';
import { assertPathIdentity, pathIdentity, pathInside, pinPathAncestry, storeDirectory, type PathIdentity } from './target.js';
import { ControlStoreError } from './control-state.js';

export type PersistenceBoundary = 'before_write' | 'after_write' | 'after_file_sync' | 'before_rename' | 'after_rename' | 'after_directory_sync';
export function sha256(data: string | Buffer): string { return createHash('sha256').update(data).digest('hex'); }

export function guardOwnedPaths(owner: DaemonOwnership, paths: readonly string[]): () => void {
  const targets = paths.map(input => ({ input, canonical: owner.assertOwnsPath(input) }));
  const pins = new Map<string, PathIdentity>();
  for (const { canonical } of targets) {
    let existing = canonical;
    for (;;) {
      try {
        const stat = lstatSync(existing);
        if (!stat.isDirectory()) { pins.set(existing, pathIdentity(existing)); existing = dirname(existing); }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        existing = dirname(existing);
      }
    }
    for (const pin of pinPathAncestry(existing)) pins.set(pin.path, pin);
  }
  return () => {
    owner.assertCurrent();
    for (const pin of pins.values()) assertPathIdentity(pin);
    for (const target of targets) if (owner.assertOwnsPath(target.input) !== target.canonical) throw new ControlStoreError('ownership_lost', 'An owned path changed its canonical destination.');
    owner.assertCurrent();
  };
}

export function syncOwnedDirectory(owner: DaemonOwnership, directory: string): void {
  const path = owner.assertOwnsPath(directory);
  const check = guardOwnedPaths(owner, [path]);
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true }); const pin = pathIdentity(path);
    if (stat.dev !== pin.dev || stat.ino !== pin.ino) throw new ControlStoreError('ownership_lost', 'Directory changed while syncing.');
    check(); fsyncSync(fd); check();
  } finally { closeSync(fd); }
}

export function prepareControlDirectory(owner: DaemonOwnership, directory: string): string {
  const canonical = owner.assertOwnsPath(directory);
  const check = guardOwnedPaths(owner, [directory]);
  const actual = storeDirectory(canonical);
  check();
  if (actual !== canonical) throw new ControlStoreError('ownership_lost', 'Directory changed while creating it.');
  for (let path = canonical;; path = dirname(path)) {
    syncOwnedDirectory(owner, path);
    if (owner.target.rootSet.includes(path)) break;
  }
  return actual;
}

export class AtomicControlFile {
  readonly directory: string;
  private readonly path: string;
  private readonly marker: string;
  private unwatch: () => void = () => {};
  private pin: PathIdentity | undefined;
  private markerPin!: PathIdentity;
  private readonly initialization: string;
  private initializationPin!: PathIdentity;
  private poisoned = false;
  private closed = false;
  private sequence = 0;
  private storeId!: string;

  constructor(readonly owner: DaemonOwnership, directory: string, private readonly fault?: (boundary: PersistenceBoundary) => void) {
    this.directory = owner.assertOwnsPath(directory);
    if (pathInside(this.directory, owner.target.agentDir)) throw new ControlStoreError('invalid_request', 'Control state cannot contain its independent initialization record.');
    this.initialization = join(owner.target.agentDir, `.control-initialized-${sha256(this.directory)}.json`);
    this.path = join(this.directory, 'control.json'); this.marker = join(this.directory, 'format.json');
    try { this.open(); }
    catch (error) {
      this.unwatch(); owner.assertCurrent();
      if (!integrityFailure(error)) throw unreadable(error);
      // Unusable control state is moved aside and rebuilt; transcripts remain the durable session record.
      try { renameSync(this.directory, `${this.directory}.corrupt-${Date.now()}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      try { unlinkSync(this.initialization); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      try { this.open(); }
      catch { this.unwatch(); throw new ControlStoreError('storage_failure', 'Control store cannot be created.'); }
    }
  }
  private open(): void {
    const owner = this.owner;
    let initialized: string | undefined;
    try { initialized = this.readFile(this.initialization); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (initialized === undefined) {
      try { if (readdirSync(this.directory).length !== 0) throw new Error('unregistered control state'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.storeId = randomUUID();
      const fd = openSync(this.initialization, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify({ version: 1, storeId: this.storeId, directory: this.directory })); fsyncSync(fd); }
      finally { closeSync(fd); }
      syncOwnedDirectory(owner, owner.target.agentDir);
      prepareControlDirectory(owner, this.directory);
    } else {
      const value = JSON.parse(initialized) as { version?: unknown; storeId?: unknown; directory?: unknown };
      if (value.version !== 1 || typeof value.storeId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.storeId) || value.directory !== this.directory) throw new Error('initialization');
      this.storeId = value.storeId;
    }
    this.initializationPin = pathIdentity(this.initialization);
    this.unwatch = owner.watchPath(this.directory);
    for (const file of readdirSync(this.directory)) {
      if (!/^control-[0-9a-f-]{36}\.tmp$/.test(file)) continue;
      owner.assertCurrent(); unlinkSync(join(this.directory, file));
    }
    let marker: string;
    try { marker = this.readFile(this.marker); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (initialized !== undefined) throw new Error('missing initialized control state');
      marker = JSON.stringify({ version: 1, storeId: this.storeId });
      const fd = openSync(this.marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, marker); fsyncSync(fd); } finally { closeSync(fd); }
      this.syncDirectory();
      this.markerPin = pathIdentity(this.marker);
      this.write(null);
      return;
    }
    const value = JSON.parse(marker) as { version?: unknown; storeId?: unknown };
    if (value.version !== 1 || value.storeId !== this.storeId) throw new Error('format');
    this.markerPin = pathIdentity(this.marker);
    try { this.pin = pathIdentity(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  /**
   * Returns null when the snapshot is missing or fails its integrity checks; a corrupt file is quarantined, not restored from history.
   * Other I/O failures are retryable and leave the file untouched.
   */
  read(): unknown {
    this.assertCurrent();
    let bytes: string;
    try { bytes = this.readFile(this.path); }
    catch (error) {
      this.assertCurrent();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (!integrityFailure(error)) throw unreadable(error);
      this.quarantine(); return null;
    }
    try {
      const envelope = JSON.parse(bytes) as { version?: unknown; storeId?: unknown; sequence?: unknown; data?: unknown; digest?: unknown };
      if (envelope.version !== 1 || envelope.storeId !== this.storeId || !Number.isSafeInteger(envelope.sequence) || (envelope.sequence as number) < this.sequence || sha256(JSON.stringify(envelope.data)) !== envelope.digest) throw new Error('integrity');
      this.sequence = envelope.sequence as number;
      this.assertCurrent(); return envelope.data;
    } catch {
      this.assertCurrent(); this.quarantine(); return null;
    }
  }
  /** Moves the current snapshot aside for inspection so the store can be rebuilt empty. */
  quarantine(): void {
    this.assertCurrent();
    try { renameSync(this.path, join(this.directory, `control-corrupt-${Date.now()}.json`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.pin = undefined;
    this.syncDirectory();
  }
  write(data: unknown): void {
    this.assertCurrent();
    const sequence = this.sequence + 1;
    if (!Number.isSafeInteger(sequence)) throw new ControlStoreError('storage_failure', 'Control sequence exhausted.');
    const serialized = JSON.stringify(data);
    const bytes = JSON.stringify({ version: 1, storeId: this.storeId, sequence, digest: sha256(serialized), data });
    const temp = join(this.directory, `control-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      this.fault?.('before_write'); this.assertCurrent();
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, bytes); this.fault?.('after_write'); this.assertCurrent();
      fsyncSync(fd); this.fault?.('after_file_sync'); this.assertCurrent();
      closeSync(fd); fd = undefined;
      this.fault?.('before_rename'); this.assertCurrent();
      renameSync(temp, this.path); this.pin = pathIdentity(this.path);
      this.fault?.('after_rename'); this.assertCurrent();
      this.syncDirectory(); this.fault?.('after_directory_sync'); this.assertCurrent();
      this.sequence = sequence;
    } catch {
      this.poisoned = true;
      throw new ControlStoreError('storage_failure', 'Control commit failed; outcome is uncertain. Stop admission and reopen only after writers settle.');
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.poisoned = true; }
    }
  }
  assertCurrent(): void {
    if (this.closed || this.poisoned) throw new ControlStoreError('storage_failure', 'Control store is closed or fenced after a failed commit.');
    this.owner.assertCurrent();
    if (this.initializationPin) assertPathIdentity(this.initializationPin);
    if (this.markerPin) assertPathIdentity(this.markerPin);
    if (this.pin) assertPathIdentity(this.pin);
  }
  close(): void { this.closed = true; this.unwatch(); }
  private readFile(path: string): string {
    this.owner.assertCurrent();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd)); }
    finally { closeSync(fd); }
  }
  private syncDirectory(): void {
    syncOwnedDirectory(this.owner, this.directory);
  }
}

/** Corrupt, foreign or substituted state is rebuilt; ownership loss and transient I/O errors must not discard it. */
function integrityFailure(error: unknown): boolean {
  if (error instanceof ControlStoreError || (error as { name?: unknown } | null)?.name === 'DaemonSecurityError') return false;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === undefined || ['ENOENT', 'ELOOP', 'ENOTDIR', 'EISDIR', 'EEXIST', 'ERR_ENCODING_INVALID_ENCODED_DATA'].includes(code);
}

function unreadable(error: unknown): unknown {
  if (error instanceof ControlStoreError || (error as { name?: unknown } | null)?.name === 'DaemonSecurityError') return error;
  const code = (error as NodeJS.ErrnoException | null)?.code ?? 'unknown';
  return new ControlStoreError('storage_failure', `Control state could not be read (${code}); it was left in place. Retry starting the daemon.`);
}
