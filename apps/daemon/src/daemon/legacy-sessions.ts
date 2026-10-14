import { constants, type Dirent, type Stats } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalPath } from './profile-storage.js';
import { parseSchema } from '@felan-ai/session-protocol';
import type { ControlSession } from './control-state.js';
import type { DaemonOwnership } from './ownership.js';
import { sessionHeaderSchema } from './session-files.js';

export const LEGACY_SESSION_LIMITS = Object.freeze({
  headerBytes: 64 * 1024,
});

export interface LegacySession {
  readonly id: string; readonly cwd: string; readonly path: string; readonly modifiedAt: number; readonly title: string; readonly preview: string;
}

type Owner = Pick<DaemonOwnership, 'target'>;
const sessionId = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

// Pi's default per-cwd directory name under agentDir/sessions, as written by pre-daemon Felan.
export function legacySessionDirectoryName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`;
}

/**
 * Finds unregistered Pi transcripts in the pre-daemon layouts of the owned stores: the per-cwd
 * directories under agentDir/sessions and the top level of each store root (custom session
 * directories). Only a bounded prefix of each file is read; malformed and registered files are skipped.
 */
export async function discoverLegacySessions(owner: Owner, registered: readonly Pick<ControlSession, 'id' | 'piPath'>[], cwd?: string): Promise<LegacySession[]> {
  const sessions = join(owner.target.agentDir, 'sessions');
  // A transcript written under a symlinked project path lives in that path's directory, so a cwd filter cannot narrow the scan.
  const nested = (await entries(sessions)).filter(entry => !entry.isFile() && /^--.+--$/u.test(entry.name)).map(entry => join(sessions, entry.name));
  const directories = [sessions, ...nested, ...owner.target.rootSet.filter(root => root !== owner.target.agentDir && root !== sessions)];
  const paths = new Set(registered.map(row => row.piPath)); const ids = new Set(registered.map(row => row.id));
  const files: { path: string; stat: Stats }[] = [];
  for (const directory of directories) {
    for (const entry of await entries(directory)) {
      if (!entry.name.endsWith('.jsonl')) continue;
      const path = join(directory, entry.name);
      if (paths.has(path)) continue;
      try {
        const info = await stat(path);
        if (info.isFile()) files.push({ path, stat: info });
      } catch { /* Discovery is best-effort; an unreadable file is not a session. */ }
    }
  }
  files.sort((a, b) => a.stat.mtimeMs === b.stat.mtimeMs ? a.path.localeCompare(b.path) : b.stat.mtimeMs - a.stat.mtimeMs);
  const found: LegacySession[] = [];
  for (const file of files) {
    const header = await readHeader(file.path);
    if (!header || ids.has(header.id)) continue;
    const canonical = await canonicalPath(header.cwd).catch(() => header.cwd);
    if (cwd !== undefined && canonical !== cwd) continue;
    ids.add(header.id);
    found.push({ id: header.id, cwd: canonical, path: file.path, modifiedAt: Math.floor(file.stat.mtimeMs), title: header.title, preview: header.preview });
  }
  return found;
}

async function entries(directory: string): Promise<Dirent[]> {
  try { return await readdir(directory, { withFileTypes: true }); } catch { return []; }
}

async function readHeader(path: string): Promise<{ id: string; cwd: string; title: string; preview: string } | undefined> {
  try {
    const prefix = await readPrefix(path);
    const end = prefix?.indexOf(10) ?? -1;
    if (!prefix || end < 0) return undefined;
    const header = parseSchema(sessionHeaderSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(prefix.subarray(0, end))));
    return sessionId.test(header.id) ? { id: header.id, cwd: header.cwd, ...summarize(entriesOf(prefix.subarray(end + 1))) } : undefined;
  } catch { return undefined; }
}

/** First user message of a transcript file, from the same bounded prefix as discovery; empty when absent or unreadable. */
export async function readTranscriptPreview(path: string): Promise<string> {
  try {
    const prefix = await readPrefix(path);
    const end = prefix?.indexOf(10) ?? -1;
    return prefix && end >= 0 ? summarize(entriesOf(prefix.subarray(end + 1))).preview : '';
  } catch { return ''; }
}

/** First user message among in-memory Pi session entries. */
export function transcriptPreview(entries: Iterable<unknown>): string { return summarize(entries).preview; }

async function readPrefix(path: string): Promise<Buffer | undefined> {
  // Non-blocking open keeps a FIFO named *.jsonl from stalling discovery.
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc(LEGACY_SESSION_LIMITS.headerBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

function* entriesOf(prefix: Buffer): Generator<unknown> {
  const complete = prefix.subarray(0, prefix.lastIndexOf(10) + 1);
  for (const line of complete.toString('utf8').split('\n')) {
    try { yield JSON.parse(line); } catch { /* Partial or foreign lines are not entries. */ }
  }
}

// Latest Pi session name and first user message; for files only the bounded prefix is seen.
function summarize(entries: Iterable<unknown>): { title: string; preview: string } {
  let name: string | undefined; let message: string | undefined;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as { type?: unknown; name?: unknown; message?: { role?: unknown; content?: unknown } };
    if (row.type === 'session_info') name = typeof row.name === 'string' ? row.name : undefined;
    else if (!message?.trim() && row.type === 'message' && row.message?.role === 'user') message = textOf(row.message.content);
  }
  return { title: snippet(name?.trim() ?? ''), preview: snippet(message ?? '') };
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
