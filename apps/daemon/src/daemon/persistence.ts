import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { DaemonOwnership } from './ownership.js';
import { assertPathIdentity, pathIdentity, pathInside, pinPathAncestry, storeDirectory, type PathIdentity } from './target.js';
import { ControlStoreError } from './control-state.js';

export type PersistenceBoundary = 'before_commit' | 'after_commit';
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

/** Session projections are stored as their own rows, keyed by `[session, key]`. */
export const CONTROL_TABLES = ['sessions', 'requests', 'interactions', 'continuations', 'resources', 'projections'] as const;
export type ControlTable = typeof CONTROL_TABLES[number];
/** A persisted record; `ord` orders a table's rows as the in-memory arrays they were written from. */
export interface ControlRow { readonly id: string; readonly ord: number; readonly data: string }
export interface ControlMeta { readonly namespace: string; readonly agentDir: string; readonly clock: number }
export interface StoredControl { readonly meta: ControlMeta; readonly rows: Readonly<Record<ControlTable, readonly ControlRow[]>> }
export interface ControlChanges {
  readonly meta: ControlMeta;
  readonly upserts: readonly (readonly [ControlTable, ControlRow])[];
  readonly deletes: readonly (readonly [ControlTable, string])[];
}

const DATABASE = 'control.sqlite';
const FORMAT = '2';
const SIDECARS = ['-wal', '-shm', '-journal'] as const;
// fullfsync keeps the darwin F_FULLFSYNC flush that Node's fsync used; a busy file fails fast instead of stalling the daemon.
const PRAGMAS = 'PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA fullfsync = ON; PRAGMA checkpoint_fullfsync = ON; PRAGMA busy_timeout = 1000';
/** SQLite primary result codes that describe the environment, not the file's contents. */
const SQLITE_TRANSIENT = new Set([3 /* PERM */, 5 /* BUSY */, 6 /* LOCKED */, 7 /* NOMEM */, 8 /* READONLY */, 10 /* IOERR */, 13 /* FULL */, 14 /* CANTOPEN */]);
const LEGACY_MIGRATED = 'migrated-to-v2.json';

type Statements = Record<ControlTable, { upsert: StatementSync; remove: StatementSync; rows: StatementSync }> & { putMeta: StatementSync; meta: StatementSync };

let sqlite: typeof import('node:sqlite') | undefined;
/** Loads node:sqlite on first use so clients that import daemon modules never load it. */
function loadSqlite(): typeof import('node:sqlite') {
  if (sqlite) return sqlite;
  const emitWarning = process.emitWarning;
  // Supported Node lines mark node:sqlite experimental; its one-time warning would reach foreground daemon output.
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning instanceof Error ? warning.message : warning).startsWith('SQLite is an experimental feature')) return;
    (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try { sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'); }
  finally { process.emitWarning = emitWarning; }
  return sqlite;
}

/**
 * The control store's SQLite database. A commit writes only the rows that changed, in one
 * synchronous-FULL WAL transaction, after rechecking ownership and the pinned file identities.
 */
export class ControlDatabase {
  readonly directory: string;
  private readonly path: string;
  private readonly initialization: string;
  private initializationPin!: PathIdentity;
  private pin: PathIdentity | undefined;
  private unwatch: () => void = () => {};
  private db: DatabaseSync | undefined;
  private statements: Statements | undefined;
  private poisoned = false;
  private closed = false;
  private storeId!: string;

  constructor(readonly owner: DaemonOwnership, directory: string, private readonly fault?: (boundary: PersistenceBoundary) => void) {
    this.directory = owner.assertOwnsPath(directory);
    if (pathInside(this.directory, owner.target.agentDir)) throw new ControlStoreError('invalid_request', 'Control state cannot contain its independent initialization record.');
    this.initialization = join(owner.target.agentDir, `.control-initialized-${sha256(this.directory)}.json`);
    this.path = join(this.directory, DATABASE);
    try { this.open(); }
    catch (error) {
      this.release(); owner.assertCurrent();
      if (!integrityFailure(error)) throw unreadable(error);
      // Unusable control state is moved aside and rebuilt; transcripts remain the durable session record.
      try { renameSync(this.directory, `${this.directory}.corrupt-${Date.now()}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      try { unlinkSync(this.initialization); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      try { this.open(); }
      catch { this.release(); throw new ControlStoreError('storage_failure', 'Control store cannot be created.'); }
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
    if (this.present()) {
      try { this.connect(); return; }
      catch (error) {
        this.disconnect();
        if (!(error instanceof DatabaseIntegrityError)) throw error;
        this.quarantineFiles();
      }
    }
    this.create();
  }
  /**
   * False when no database exists. A database or sidecar that is not a regular file is quarantined, because
   * SQLite follows links. Unreadable files fail retryably.
   */
  private present(): boolean {
    const files = [this.path, ...SIDECARS.map(extension => `${this.path}${extension}`)].map(path => {
      try { return lstatSync(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    });
    if (files.some(stat => stat && !stat.isFile())) { this.quarantineFiles(); return false; }
    if (!files[0]) return false;
    closeSync(openSync(this.path, constants.O_RDWR | constants.O_NOFOLLOW));
    return true;
  }
  private connect(): void {
    const db = this.db = new (loadSqlite().DatabaseSync)(this.path);
    try {
      db.exec(PRAGMAS);
      if ((db.prepare('PRAGMA quick_check').get() as { quick_check?: unknown } | undefined)?.quick_check !== 'ok') throw new DatabaseIntegrityError();
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => (row as { name: string }).name));
      if (!['meta', ...CONTROL_TABLES].every(table => tables.has(table))) throw new DatabaseIntegrityError();
      const meta = new Map((db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map(row => [row.key, row.value]));
      if (meta.get('format') !== FORMAT || meta.get('storeId') !== this.storeId) throw new DatabaseIntegrityError();
      // Rows without the state metadata cannot be validated against their namespace; never resurrect them under a new one.
      if (!meta.has('namespace') && CONTROL_TABLES.some(table => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined)) throw new DatabaseIntegrityError();
      this.statements = prepareStatements(db);
    } catch (error) {
      // Past opening the file, a non-environmental SQLite error means the schema is not this format's.
      const code = (error as { errcode?: unknown } | null)?.errcode;
      if (typeof code === 'number' && !SQLITE_TRANSIENT.has(code & 0xff)) throw new DatabaseIntegrityError();
      throw error;
    }
    this.pin = pathIdentity(this.path);
  }
  private create(): void {
    // A WAL left without its database would be replayed into the new file.
    if (SIDECARS.some(extension => { try { lstatSync(`${this.path}${extension}`); return true; } catch { return false; } })) this.quarantineFiles();
    closeSync(openSync(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
    const db = this.db = new (loadSqlite().DatabaseSync)(this.path);
    db.exec(PRAGMAS);
    db.exec(['BEGIN IMMEDIATE', 'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
      ...CONTROL_TABLES.map(table => `CREATE TABLE ${table} (id TEXT PRIMARY KEY, ord INTEGER NOT NULL, data TEXT NOT NULL) STRICT`)].join('; '));
    this.statements = prepareStatements(db);
    this.statements.putMeta.run('format', FORMAT); this.statements.putMeta.run('storeId', this.storeId);
    db.exec('COMMIT');
    this.syncDirectory();
    this.pin = pathIdentity(this.path);
  }
  /** Null until the first state is written. */
  read(): StoredControl | null {
    this.assertCurrent();
    const meta = this.meta();
    const namespace = meta.get('namespace'); const agentDir = meta.get('agentDir');
    if (namespace === undefined || agentDir === undefined) return null;
    const rows = Object.fromEntries(CONTROL_TABLES.map(table => [table, this.statements![table].rows.all() as unknown as ControlRow[]])) as Record<ControlTable, ControlRow[]>;
    this.assertCurrent();
    return { meta: { namespace, agentDir, clock: Number(meta.get('clock')) }, rows };
  }
  /** Moves the database aside for inspection and starts an empty one. */
  quarantine(): void {
    this.assertCurrent();
    this.disconnect(); this.quarantineFiles(); this.create();
  }
  write(changes: ControlChanges): void {
    this.assertCurrent();
    const db = this.db!; const statements = this.statements!;
    let open = false;
    try {
      db.exec('BEGIN IMMEDIATE'); open = true;
      for (const [table, id] of changes.deletes) statements[table].remove.run(id);
      for (const [table, row] of changes.upserts) statements[table].upsert.run(row.id, row.ord, row.data);
      statements.putMeta.run('namespace', changes.meta.namespace); statements.putMeta.run('agentDir', changes.meta.agentDir);
      statements.putMeta.run('clock', String(changes.meta.clock));
      this.fault?.('before_commit'); this.assertCurrent();
      db.exec('COMMIT'); open = false;
      this.fault?.('after_commit'); this.assertCurrent();
    } catch {
      if (open) try { db.exec('ROLLBACK'); } catch { /* The handle is fenced below either way. */ }
      this.poisoned = true;
      throw new ControlStoreError('storage_failure', 'Control commit failed; outcome is uncertain. Stop admission and reopen only after writers settle.');
    }
  }
  assertCurrent(): void {
    if (this.closed || this.poisoned) throw new ControlStoreError('storage_failure', 'Control store is closed or fenced after a failed commit.');
    this.owner.assertCurrent();
    if (this.initializationPin) assertPathIdentity(this.initializationPin);
    if (this.pin) assertPathIdentity(this.pin);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.release();
  }
  private release(): void { this.disconnect(); this.unwatch(); }
  private disconnect(): void {
    try { this.db?.close(); } catch { /* A failed close leaves nothing to recover in this handle. */ }
    this.db = undefined; this.statements = undefined; this.pin = undefined;
  }
  private meta(): Map<string, string> {
    return new Map((this.statements!.meta.all() as { key: string; value: string }[]).map(row => [row.key, row.value]));
  }
  private quarantineFiles(): void {
    const suffix = `control-corrupt-${Date.now()}-${randomUUID().slice(0, 8)}.sqlite`;
    for (const extension of ['', ...SIDECARS]) {
      try { renameSync(`${this.path}${extension}`, join(this.directory, `${suffix}${extension}`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    this.pin = undefined;
    this.syncDirectory();
  }
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

function prepareStatements(db: DatabaseSync): Statements {
  const tables = Object.fromEntries(CONTROL_TABLES.map(table => [table, {
    upsert: db.prepare(`INSERT INTO ${table} (id, ord, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET ord = excluded.ord, data = excluded.data`),
    remove: db.prepare(`DELETE FROM ${table} WHERE id = ?`),
    rows: db.prepare(`SELECT id, ord, data FROM ${table} ORDER BY ord`),
  }])) as Record<ControlTable, Statements[ControlTable]>;
  return { ...tables, putMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'), meta: db.prepare('SELECT key, value FROM meta') };
}

class DatabaseIntegrityError extends Error {}

/**
 * Reads a verified version 1 (`control.json`) snapshot without changing it. Undefined when it is absent, already
 * migrated or fails its integrity checks; other read errors fail retryably so the import is not silently skipped.
 */
export function readLegacyControlState(owner: DaemonOwnership, directory: string): unknown {
  const canonical = owner.assertOwnsPath(directory);
  const read = (path: string) => {
    owner.assertCurrent();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd))) as Record<string, unknown>; }
    finally { closeSync(fd); }
  };
  try {
    try { lstatSync(join(canonical, LEGACY_MIGRATED)); return undefined; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const initialization = read(join(owner.target.agentDir, `.control-initialized-${sha256(canonical)}.json`));
    const format = read(join(canonical, 'format.json')); const envelope = read(join(canonical, 'control.json'));
    if (initialization.version !== 1 || initialization.directory !== canonical || typeof initialization.storeId !== 'string'
      || format.version !== 1 || format.storeId !== initialization.storeId || envelope.version !== 1 || envelope.storeId !== initialization.storeId
      || sha256(JSON.stringify(envelope.data)) !== envelope.digest) return undefined;
    return envelope.data;
  } catch (error) {
    owner.assertCurrent();
    if (!integrityFailure(error)) throw unreadable(error);
    return undefined;
  }
}

/**
 * Marks a version 1 directory as imported so a later empty store never imports it again; the files stay for
 * downgrade. Does nothing when there is no version 1 snapshot or it is already marked.
 */
export function markLegacyControlStateMigrated(owner: DaemonOwnership, directory: string): void {
  const canonical = owner.assertOwnsPath(directory);
  try { lstatSync(join(canonical, 'control.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  let fd: number;
  try { fd = openSync(join(canonical, LEGACY_MIGRATED), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
  try { writeFileSync(fd, JSON.stringify({ version: 1, format: FORMAT })); fsyncSync(fd); }
  finally { closeSync(fd); }
  syncOwnedDirectory(owner, canonical);
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
