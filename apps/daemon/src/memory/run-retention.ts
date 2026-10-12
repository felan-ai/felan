import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';

export interface MemoryRunRetentionOptions {
  readonly projectDirectory: string;
  readonly sessionDirectory: string;
  readonly projectKey: string;
  readonly maxCompletedRuns?: number;
  readonly protectedRunIds?: readonly string[];
}

interface Entry {
  readonly path: string;
  readonly stat: Stats;
}

interface OwnedRun {
  readonly id: string;
  readonly projectKey: string;
  readonly active: boolean;
  readonly timestamp: number;
  readonly manifestText: string;
  readonly session: Entry;
  readonly files: readonly Entry[];
  readonly directories: readonly Entry[];
  readonly safeToDelete: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const METADATA_BYTES = 64 * 1_024;
const ACTIVE_STATUSES = new Set(['started', 'worker_completed']);
const STATUSES = new Set([...ACTIVE_STATUSES, 'completed', 'failed', 'cancelled', 'blocked', 'interrupted']);

// Unverified records and orphan memory sessions are preserved. Symlink targets are never
// followed; positively verified foreign-project records are excluded.
export async function pruneMemoryRuns(options: MemoryRunRetentionOptions): Promise<{ terminalRuns: number; overLimit: boolean }> {
  const maxCompletedRuns = options.maxCompletedRuns ?? 50;
  if (!Number.isSafeInteger(maxCompletedRuns) || maxCompletedRuns < 0) {
    throw new RangeError('Memory retention maxCompletedRuns must be a nonnegative safe integer');
  }
  for (const [name, value] of Object.entries({ maxCompletedRuns })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Memory retention ${name} must be a nonnegative safe integer`);
  }
  if (!options.projectKey || !options.projectDirectory || !options.sessionDirectory) {
    throw new Error('Memory retention requires project and session directories and a project key');
  }

  const project = await rootDirectory(options.projectDirectory);
  const sessions = await rootDirectory(options.sessionDirectory);
  const runs = project && await rootDirectory(join(project.path, 'runs'));
  const roots = [project, sessions, runs].filter((entry): entry is Entry => entry !== undefined);
  const protectedIds = new Set(options.protectedRunIds);
  const retained = (await inventory(runs, sessions, options.projectKey)).runs;
  let terminalRuns = retained.filter((run) => !run.active).length;

  for (const run of retained.sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))) {
    if (run.active || protectedIds.has(run.id) || !run.safeToDelete) continue;
    if (terminalRuns <= maxCompletedRuns) break;
    if (!await matchesDirectories(roots)) throw new Error('Memory retention directories changed');
    const current = runs && sessions && await ownedRun(runs, sessions, run.id);
    if (!current || current.projectKey !== options.projectKey || current.active || !current.safeToDelete || !sameRun(run, current)) continue;
    await removeRun(current, roots);
    terminalRuns -= 1;
  }

  if (!await matchesDirectories(roots)) throw new Error('Memory retention directories changed');
  const remaining = (await inventory(runs, sessions, options.projectKey)).runs;
  terminalRuns = remaining.filter((run) => !run.active).length;
  return { terminalRuns, overLimit: terminalRuns > maxCompletedRuns };
}

async function rootDirectory(path: string): Promise<Entry | undefined> {
  const entry = await entryAt(resolve(path));
  if (!entry) return undefined;
  if (!entry.stat.isDirectory()) throw new Error('Memory retention requires real directories, not symlinks or files');
  const canonical = await entryAt(await realpath(entry.path));
  if (!canonical || !sameNode(entry, canonical)) throw new Error('Memory retention directory changed');
  return canonical;
}

async function inventory(runs: Entry | undefined, sessions: Entry | undefined, projectKey: string): Promise<{
  runs: OwnedRun[];
}> {
  const retained: OwnedRun[] = [];
  const pairedSessions = new Set<string>();
  if (runs) {
    for (const id of await readdir(runs.path)) {
      const run = UUID.test(id) && sessions ? await ownedRun(runs, sessions, id) : undefined;
      if (!run) continue;
      if (run.projectKey !== projectKey) continue;
      retained.push(run);
      pairedSessions.add(run.session.path);
    }
  }
  if (sessions) {
    for (const name of await readdir(sessions.path)) {
      if (!isSessionFileName(name)) continue;
      const path = join(sessions.path, name);
      if (pairedSessions.has(path)) continue;
      const session = await readPrefix(path, false);
      if (!session || initialIdentity(session.text)?.projectKey !== projectKey) continue;
    }
  }
  return { runs: retained };
}

async function ownedRun(runs: Entry, sessions: Entry, id: string): Promise<OwnedRun | undefined> {
  const directory = await entryAt(join(runs.path, id));
  if (!directory?.stat.isDirectory()) return undefined;
  const manifest = await readPrefix(join(directory.path, 'manifest.json'), true);
  if (!manifest) return undefined;
  const metadata = parseObject(manifest.text);
  const projectKey = metadata?.projectKey;
  if (typeof projectKey !== 'string' || !projectKey) return undefined;
  if (!hasIdentity(metadata, id, projectKey) || typeof metadata.status !== 'string' || !STATUSES.has(metadata.status)) return undefined;
  const timestamp = isoTimestamp(metadata.startedAt);
  const finishedAt = metadata.finishedAt === undefined ? undefined : isoTimestamp(metadata.finishedAt);
  if (timestamp === undefined || (metadata.finishedAt !== undefined && (finishedAt === undefined || finishedAt < timestamp))) return undefined;
  const name = metadata.sessionFile;
  if (!isSessionFileName(name)) return undefined;
  const sessionPath = join(sessions.path, name);
  if (sessionPath.startsWith(`${directory.path}${sep}`)) return undefined;
  const session = await readPrefix(sessionPath, false);
  const identity = session && initialIdentity(session.text);
  if (!session || identity?.id !== id || identity.projectKey !== projectKey) return undefined;

  const files: Entry[] = [];
  const directories: Entry[] = [directory];
  let safeToDelete = true;
  for (let index = 0; index < directories.length; index += 1) {
    const parent = directories[index]!;
    if (!await matchesDirectories(directories)) return undefined;
    for (const name of await readdir(parent.path)) {
      const entry = await entryAt(join(parent.path, name));
      if (!entry) return undefined;
      if (entry.stat.isFile()) files.push(entry);
      else if (entry.stat.isDirectory()) directories.push(entry);
      else safeToDelete = false;
    }
  }
  if (!await matchesDirectories(directories)) return undefined;
  const manifestEntry = files.find((entry) => entry.path === manifest.entry.path);
  if (!manifestEntry || !unchanged(manifest.entry, manifestEntry)) return undefined;
  return {
    id,
    projectKey,
    active: ACTIVE_STATUSES.has(metadata.status),
    timestamp: finishedAt ?? timestamp,
    manifestText: manifest.text,
    session: session.entry,
    files,
    directories,
    safeToDelete,
  };
}

async function readPrefix(path: string, wholeFile: boolean): Promise<{ entry: Entry; text: string } | undefined> {
  const entry = await entryAt(path);
  if (!entry?.stat.isFile() || (wholeFile && entry.stat.size > METADATA_BYTES)) return undefined;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = { path, stat: await handle.stat() };
      if (!opened.stat.isFile() || !sameNode(entry, opened) || (wholeFile && opened.stat.size > METADATA_BYTES)) return undefined;
      const buffer = Buffer.alloc(Math.min(opened.stat.size, METADATA_BYTES));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const current = await entryAt(path);
      if (!current || !sameNode(opened, current) || (wholeFile && (!unchanged(opened, current) || length !== current.stat.size))) return undefined;
      return { entry: current, text: buffer.subarray(0, length).toString('utf8') };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (unavailable(error)) return undefined;
    throw error;
  }
}

function isSessionFileName(value: unknown): value is string {
  return typeof value === 'string' && value === basename(value) && value.endsWith('.jsonl') && !/[/\\:\x00-\x1f\x7f]/u.test(value);
}

function initialIdentity(text: string): { id: string; projectKey: string } | undefined {
  const lines = text.split('\n');
  lines.pop();
  const header = parseObject(lines.shift() ?? '');
  if (header?.type !== 'session' || typeof header.id !== 'string' || !UUID.test(header.id)) return undefined;
  for (const line of lines) {
    const entry = parseObject(line);
    if (!entry) return undefined;
    if (entry.type === 'custom' && entry.customType === 'felan-memory-run') {
      const data = entry.data;
      const projectKey = data !== null && typeof data === 'object' && 'projectKey' in data ? data.projectKey : undefined;
      return typeof projectKey === 'string' && projectKey && hasIdentity(data, header.id, projectKey)
        ? { id: header.id, projectKey }
        : undefined;
    }
    if (!['session_info', 'model_change', 'thinking_level_change'].includes(String(entry.type))) return undefined;
  }
  return undefined;
}

function hasIdentity(value: unknown, id: string, projectKey: string): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && 'version' in value && value.version === 1 && 'kind' in value && value.kind === 'memory'
    && 'sessionId' in value && value.sessionId === id && 'projectKey' in value && value.projectKey === projectKey;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function isoTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return undefined;
  const local = Date.parse(`${value.slice(0, 19)}Z`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(local) || !Number.isFinite(timestamp) || new Date(local).toISOString().slice(0, 19) !== value.slice(0, 19)) return undefined;
  return timestamp;
}

function sameRun(left: OwnedRun, right: OwnedRun): boolean {
  return left.manifestText === right.manifestText && unchanged(left.session, right.session)
    && left.files.length === right.files.length && left.directories.length === right.directories.length
    && left.files.every((entry) => right.files.some((other) => entry.path === other.path && unchanged(entry, other)))
    && left.directories.every((entry) => right.directories.some((other) => entry.path === other.path && sameNode(entry, other)));
}

async function removeRun(run: OwnedRun, roots: readonly Entry[]): Promise<void> {
  const directories = [...roots, ...run.directories];
  const manifestPath = join(run.directories[0]!.path, 'manifest.json');
  const files = [...run.files.filter((entry) => entry.path !== manifestPath), run.files.find((entry) => entry.path === manifestPath)!];
  // Unlink only inventoried files. Recursive removal could consume newly added or unverified entries.
  for (const file of files) {
    const ancestors = directories.filter((entry) => file.path.startsWith(`${entry.path}${sep}`));
    const current = await entryAt(file.path);
    if (!current || !unchanged(file, current) || !await matchesDirectories(ancestors)
      || !await matchesDirectories(roots) || !unchangedSession(run.session, await entryAt(run.session.path))) {
      throw new Error('Memory run changed during retention');
    }
    await unlink(file.path);
  }
  for (const directory of [...run.directories].reverse()) {
    const ancestors = directories.filter((entry) => directory.path === entry.path || directory.path.startsWith(`${entry.path}${sep}`));
    if (!await matchesDirectories(ancestors)) throw new Error('Memory run directory changed during retention');
    await rmdir(directory.path);
  }
  if (!await matchesDirectories(roots) || !unchangedSession(run.session, await entryAt(run.session.path))) {
    throw new Error('Memory session changed during retention');
  }
  await unlink(run.session.path);
}

function unchangedSession(expected: Entry, actual: Entry | undefined): boolean {
  return actual !== undefined && unchanged(expected, actual);
}

async function matchesDirectories(entries: readonly Entry[]): Promise<boolean> {
  for (const entry of entries) {
    const current = await entryAt(entry.path);
    if (!current?.stat.isDirectory() || !sameNode(entry, current)) return false;
  }
  return true;
}

function sameNode(left: Entry, right: Entry): boolean {
  return left.stat.dev === right.stat.dev && left.stat.ino === right.stat.ino && left.stat.mode === right.stat.mode;
}

function unchanged(left: Entry, right: Entry): boolean {
  return sameNode(left, right) && left.stat.size === right.stat.size
    && left.stat.mtimeMs === right.stat.mtimeMs && left.stat.ctimeMs === right.stat.ctimeMs;
}

async function entryAt(path: string): Promise<Entry | undefined> {
  try {
    return { path, stat: await lstat(path) };
  } catch (error) {
    if (unavailable(error)) return undefined;
    throw error;
  }
}

function unavailable(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error
    && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code));
}
