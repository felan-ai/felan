import { constants, type Dirent, type Stats } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { canonicalPath } from './profile-storage.js';
import { parseSchema } from '@felan-ai/session-protocol';
import type { ControlSession } from './control-state.js';
import type { DaemonOwnership } from './ownership.js';
import { isConversationEntry, sessionHeaderSchema } from './session-files.js';

/** An unregistered pre-daemon transcript; `LegacySessionIndex.summary` supplies its title and preview. */
export interface LegacySession {
  readonly id: string; readonly cwd: string; readonly path: string; readonly modifiedAt: number;
}
/** Display snippets of the latest Pi session name and the first user message. */
export interface LegacySummary { readonly title: string; readonly preview: string }

type Owner = Pick<DaemonOwnership, 'target'>;
type Header = { id: string; cwd: string };
type Transcript = Header & LegacySummary;
const sessionId = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const EMPTY: LegacySummary = Object.freeze({ title: '', preview: '' });
const HEADER_CHUNK = 4096;
const HEADER_BYTES = 64 * 1024;
const INDEX_CONCURRENCY = 16;
const SUMMARY_READS = 4;
const WARM_READS = 2;

// Pi's default per-cwd directory name under agentDir/sessions, as written by pre-daemon Felan.
export function legacySessionDirectoryName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`;
}

/**
 * Finds unregistered Pi transcripts in the pre-daemon layouts of the owned stores: the per-cwd
 * directories under agentDir/sessions and the top level of each store root (custom session
 * directories). Discovery reads only header lines. A summary needs the whole file, like Pi's
 * session list, so it is read on request. Both are cached until the file changes.
 */
export class LegacySessionIndex {
  private readonly headers = new Map<string, { version: string; header: Header | undefined }>();
  private readonly summaries = new Map<string, { version: string; id: string; summary: LegacySummary }>();
  private readonly reading = new Map<string, Promise<Transcript | undefined>>();
  // Listing pages and the warm-up share these, so neither can flood the file system.
  private readonly reads = new Slots(SUMMARY_READS);

  constructor(private readonly owner: Owner) {}

  /** Newest first. Malformed and registered files are skipped; a duplicated ID keeps only its newest file. */
  async discover(registered: readonly Pick<ControlSession, 'id' | 'piPath'>[], options: { cwd?: string; signal?: AbortSignal } = {}): Promise<LegacySession[]> {
    const { cwd, signal } = options;
    const sessions = join(this.owner.target.agentDir, 'sessions');
    // A transcript written under a symlinked project path lives in that path's directory, so a cwd filter cannot narrow the scan.
    const nested = (await entries(sessions)).filter(entry => !entry.isFile() && /^--.+--$/u.test(entry.name)).map(entry => join(sessions, entry.name));
    const directories = [sessions, ...nested, ...this.owner.target.rootSet.filter(root => root !== this.owner.target.agentDir && root !== sessions)];
    const listings = await limited(directories, INDEX_CONCURRENCY, signal, async directory =>
      (await entries(directory)).filter(entry => entry.name.endsWith('.jsonl')).map(entry => join(directory, entry.name)));
    const skipped = new Set(registered.map(row => row.piPath));
    const paths = [...new Set(listings.flat())].filter(path => !skipped.has(path));
    const canonical = new Map<string, Promise<string>>();
    const files = (await limited(paths, INDEX_CONCURRENCY, signal, async path => {
      let info: Stats;
      try { info = await stat(path); } catch { return undefined; }
      if (!info.isFile()) return undefined;
      const header = await this.header(path, info);
      if (!header) return undefined;
      let resolved = canonical.get(header.cwd);
      if (!resolved) canonical.set(header.cwd, resolved = canonicalPath(header.cwd).catch(() => header.cwd));
      return { id: header.id, cwd: await resolved, path, mtimeMs: info.mtimeMs };
    })).filter((file): file is NonNullable<typeof file> => file !== undefined);
    const present = new Set(paths);
    for (const cache of [this.headers, this.summaries]) for (const path of cache.keys()) if (!present.has(path)) cache.delete(path);
    files.sort((a, b) => a.mtimeMs === b.mtimeMs ? a.path.localeCompare(b.path) : b.mtimeMs - a.mtimeMs);
    const ids = new Set(registered.map(row => row.id)); const found: LegacySession[] = [];
    for (const file of files) {
      if (ids.has(file.id)) continue;
      ids.add(file.id);
      if (cwd === undefined || file.cwd === cwd) found.push({ id: file.id, cwd: file.cwd, path: file.path, modifiedAt: Math.floor(file.mtimeMs) });
    }
    return found;
  }

  /** Empty when the file is gone, unreadable or no longer holds this session. */
  async summary(session: Pick<LegacySession, 'id' | 'path'>): Promise<LegacySummary> {
    let info: Stats;
    try { info = await stat(session.path); } catch { return EMPTY; }
    const version = fileVersion(info);
    const cached = this.summaries.get(session.path);
    if (cached?.version === version) return cached.id === session.id ? cached.summary : EMPTY;
    const key = `${version}:${session.path}`;
    let read = this.reading.get(key);
    if (!read) {
      read = this.reads.run(() => readTranscript(session.path, false)).then(result => {
        if (result) this.summaries.set(session.path, { version, id: result.id, summary: { title: result.title, preview: result.preview } });
        return result;
      }).finally(() => this.reading.delete(key));
      this.reading.set(key, read);
    }
    const result = await read;
    return result?.id === session.id ? { title: result.title, preview: result.preview } : EMPTY;
  }

  /** Reads summaries in the given order, a few at a time, so listings rarely wait for a whole transcript. */
  async warm(sessions: readonly LegacySession[], signal: AbortSignal): Promise<void> {
    await limited(sessions, WARM_READS, signal, session => this.summary(session));
  }

  private async header(path: string, info: Stats): Promise<Header | undefined> {
    const version = fileVersion(info);
    const cached = this.headers.get(path);
    if (cached?.version === version) return cached.header;
    let header: Header | undefined;
    // A read failure may be transient, so only a parsed or rejected header is remembered.
    try { header = await readHeader(path); } catch { return undefined; }
    this.headers.set(path, { version, header });
    return header;
  }
}

/** Whether a transcript holds a conversation message. Unreadable files count as conversations, so they are kept. */
export async function transcriptHasConversation(path: string): Promise<boolean> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const input = handle.createReadStream({ encoding: 'utf8', autoClose: false });
    try {
      for await (const line of createInterface({ input, crlfDelay: Infinity })) {
        try { if (isConversationEntry(JSON.parse(line))) return true; } catch { /* Partial lines are not entries. */ }
      }
      return false;
    } finally { input.destroy(); await handle.close(); }
  } catch { return true; }
}

/** First user message of a transcript file; empty when absent or unreadable. */
export async function readTranscriptPreview(path: string): Promise<string> {
  return (await readTranscript(path, true))?.preview ?? '';
}

/** First user message among in-memory Pi session entries. */
export function transcriptPreview(entries: Iterable<unknown>): string {
  const summary = summarizer();
  for (const entry of entries) summary.add(entry);
  return summary.result().preview;
}

function fileVersion(info: Stats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
}

async function entries(directory: string): Promise<Dirent[]> {
  try { return await readdir(directory, { withFileTypes: true }); } catch { return []; }
}

/** Undefined when the file is not a Pi session; I/O failures throw. */
async function readHeader(path: string): Promise<Header | undefined> {
  // Non-blocking open keeps a FIFO named *.jsonl from stalling discovery.
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc(HEADER_BYTES); let length = 0; let end = -1;
    while (end < 0 && length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, Math.min(HEADER_CHUNK, buffer.length - length), length);
      if (!bytesRead) break;
      end = buffer.indexOf(10, length);
      length += bytesRead;
    }
    if (end < 0 && length === buffer.length) return undefined;
    return parseHeader(buffer.toString('utf8', 0, end < 0 ? length : end));
  } finally { await handle.close(); }
}

function parseHeader(line: string): Header | undefined {
  try {
    const header = parseSchema(sessionHeaderSchema, JSON.parse(line));
    return sessionId.test(header.id) ? { id: header.id, cwd: header.cwd } : undefined;
  } catch { return undefined; }
}

async function readTranscript(path: string, previewOnly: boolean): Promise<Transcript | undefined> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const input = handle.createReadStream({ encoding: 'utf8', autoClose: false });
    try {
      if (!(await handle.stat()).isFile()) return undefined;
      let header: Header | undefined;
      const summary = summarizer();
      for await (const line of createInterface({ input, crlfDelay: Infinity })) {
        if (!header) {
          header = parseHeader(line);
          if (!header) return undefined;
          continue;
        }
        summary.line(line);
        if (previewOnly && summary.hasPreview()) break;
      }
      return header && { ...header, ...summary.result() };
    } finally { input.destroy(); await handle.close(); }
  } catch { return undefined; }
}

// Latest Pi session name and first user message.
function summarizer() {
  let name: string | undefined; let message: string | undefined;
  const add = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') return;
    const row = entry as { type?: unknown; name?: unknown; message?: { role?: unknown; content?: unknown } };
    if (row.type === 'session_info') name = typeof row.name === 'string' ? row.name : undefined;
    else if (!message?.trim() && row.type === 'message' && row.message?.role === 'user') message = textOf(row.message.content);
  };
  return {
    add,
    line(text: string): void {
      // Pi writes entries with JSON.stringify, so a relevant entry always contains its quoted type or role; other lines are not parsed.
      if (!text.includes('"session_info"') && (message?.trim() || !text.includes('"user"'))) return;
      try { add(JSON.parse(text)); } catch { /* Partial or foreign lines are not entries. */ }
    },
    hasPreview: () => !!message?.trim(),
    result: (): LegacySummary => ({ title: snippet(name?.trim() ?? ''), preview: snippet(message ?? '') }),
  };
}

function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return content.map(part => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' ? part.text : '').join(' ');
}

function snippet(text: string): string {
  const flat = text.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  const points = [...flat];
  return points.length > 120 ? `${points.slice(0, 119).join('').trimEnd()}…` : flat;
}

/** Maps in order with at most `limit` calls in flight. Once aborted it starts no more calls and rejects after the running ones settle. */
async function limited<T, R>(items: readonly T[], limit: number, signal: AbortSignal | undefined, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let next = 0; let failed = false;
  const worker = async () => {
    try {
      while (!failed && next < items.length) {
        signal?.throwIfAborted();
        const index = next++;
        results[index] = await map(items[index]!);
      }
    } catch (error) { failed = true; throw error; }
  };
  for (const result of await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker))) if (result.status === 'rejected') throw result.reason;
  signal?.throwIfAborted();
  return results;
}

/** A counting semaphore; a released slot passes directly to the next waiter. */
class Slots {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly size: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active < this.size) this.active++;
    else await new Promise<void>(resolve => this.waiting.push(resolve));
    try { return await work(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
}
