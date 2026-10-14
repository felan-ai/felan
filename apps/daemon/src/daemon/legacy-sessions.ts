import { constants, type Dirent, type Stats } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { canonicalPath } from './profile-storage.js';
import { parseSchema } from '@felan-ai/session-protocol';
import type { ControlSession } from './control-state.js';
import type { DaemonOwnership } from './ownership.js';
import { sessionHeaderSchema } from './session-files.js';

export interface LegacySession {
  readonly id: string; readonly cwd: string; readonly path: string; readonly modifiedAt: number; readonly title: string; readonly preview: string;
}

type Owner = Pick<DaemonOwnership, 'target'>;
const sessionId = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
type Summary = { id: string; cwd: string; title: string; preview: string };
// Whole-file reads like Pi's session list; unchanged files are not re-read.
const summaries = new Map<string, { size: number; mtimeMs: number; summary: Summary | undefined }>();

// Pi's default per-cwd directory name under agentDir/sessions, as written by pre-daemon Felan.
export function legacySessionDirectoryName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`;
}

/**
 * Finds unregistered Pi transcripts in the pre-daemon layouts of the owned stores: the per-cwd
 * directories under agentDir/sessions and the top level of each store root (custom session
 * directories). Malformed and registered files are skipped.
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
    const header = await readSummary(file.path, file.stat);
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

async function readSummary(path: string, info: Stats): Promise<Summary | undefined> {
  const cached = summaries.get(path);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.summary;
  const summary = await readTranscript(path, false);
  summaries.set(path, { size: info.size, mtimeMs: info.mtimeMs, summary });
  return summary;
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

async function readTranscript(path: string, previewOnly: boolean): Promise<Summary | undefined> {
  try {
    // Non-blocking open keeps a FIFO named *.jsonl from stalling discovery.
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const input = handle.createReadStream({ encoding: 'utf8', autoClose: false });
    try {
      if (!(await handle.stat()).isFile()) return undefined;
      let header: { id: string; cwd: string } | undefined;
      const summary = summarizer();
      for await (const line of createInterface({ input, crlfDelay: Infinity })) {
        if (!header) {
          header = parseSchema(sessionHeaderSchema, JSON.parse(line));
          if (!sessionId.test(header.id)) return undefined;
          continue;
        }
        try { summary.add(JSON.parse(line)); } catch { /* Partial or foreign lines are not entries. */ }
        if (previewOnly && summary.hasPreview()) break;
      }
      return header && { id: header.id, cwd: header.cwd, ...summary.result() };
    } finally { input.destroy(); await handle.close(); }
  } catch { return undefined; }
}

// Latest Pi session name and first user message.
function summarizer() {
  let name: string | undefined; let message: string | undefined;
  return {
    add(entry: unknown): void {
      if (!entry || typeof entry !== 'object') return;
      const row = entry as { type?: unknown; name?: unknown; message?: { role?: unknown; content?: unknown } };
      if (row.type === 'session_info') name = typeof row.name === 'string' ? row.name : undefined;
      else if (!message?.trim() && row.type === 'message' && row.message?.role === 'user') message = textOf(row.message.content);
    },
    hasPreview: () => !!message?.trim(),
    result: () => ({ title: snippet(name?.trim() ?? ''), preview: snippet(message ?? '') }),
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
