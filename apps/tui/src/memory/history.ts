import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  buildSessionContext,
  parseSessionEntries,
  SessionManager,
  type SessionEntry,
  type SessionInfo,
} from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { localMemoryProjectDirectory, resolveLocalMemoryProject, type LocalMemoryProject } from './project.js';
import { MEMORY_RUN_ENTRY, sanitizeMemoryDiagnostic, type MemoryRunMetadata } from './run.js';

const MAX_TRANSCRIPT_BYTES = 16 * 1_024 * 1_024;
const MAX_CATALOG_BYTES = 256 * 1_024;
const MAX_CATALOG_TEXT = 32 * 1_024;
const MAX_MANIFEST_BYTES = 64 * 1_024;

export interface MemoryHistorySession extends SessionInfo {
  readonly memory: {
    readonly project: LocalMemoryProject;
    readonly manifestPath: string;
    readonly metadata?: MemoryRunMetadata;
  };
}

export interface LocalSessionHistory {
  readonly currentSessions: readonly SessionInfo[];
  readonly allSessions: readonly SessionInfo[];
  readonly memorySessions: ReadonlyMap<string, MemoryHistorySession>;
}

export interface MemoryHistoryOptions {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly memoryOnly?: boolean;
}

export interface MemoryHistorySnapshot {
  readonly session: MemoryHistorySession;
  readonly metadata?: MemoryRunMetadata;
  readonly messages: ReturnType<typeof buildSessionContext>['messages'];
  readonly diagnostics: readonly string[];
}

export async function listLocalSessionHistory(options: MemoryHistoryOptions): Promise<LocalSessionHistory> {
  const memoryDir = resolve(options.sessionDir, 'memory');
  const [project, currentSessions, allSessions] = await Promise.all([
    resolveLocalMemoryProject(options.cwd),
    options.memoryOnly ? Promise.resolve<SessionInfo[]>([]) : SessionManager.list(options.cwd, options.sessionDir),
    options.memoryOnly ? Promise.resolve<SessionInfo[]>([]) : SessionManager.listAll(options.sessionDir),
  ]);
  const memorySessions = new Map<string, MemoryHistorySession>();
  let retained: SessionInfo[] = [];
  try {
    await requireDirectory(memoryDir);
    retained = await listMemorySessions(memoryDir);
  } catch {}
  const projects = new Map<string, LocalMemoryProject>([[options.cwd, project]]);
  for (const session of retained) {
    if (!validMemoryRunId(session.id) || !session.cwd || dirname(resolve(session.path)) !== memoryDir) continue;
    const sessionProject = projects.get(session.cwd) ?? await resolveLocalMemoryProject(session.cwd);
    projects.set(session.cwd, sessionProject);
    const candidate: MemoryHistorySession = {
      ...session,
      memory: {
        project: sessionProject,
        manifestPath: join(localMemoryProjectDirectory(options.agentDir, sessionProject), 'runs', session.id, 'manifest.json'),
      },
    };
    const metadata = await readMemoryManifestMetadata(candidate).catch(() => undefined);
    const name = `Memory: ${safeMemoryText(basename(session.cwd)) || session.id} · ${metadata?.status ?? 'unknown'}`;
    const labeled: MemoryHistorySession = {
      ...candidate,
      name,
      allMessagesText: `${name} ${session.allMessagesText}`,
      memory: { ...candidate.memory, ...(metadata ? { metadata } : {}) },
    };
    memorySessions.set(labeled.path, labeled);
    allSessions.push(labeled);
    if (sessionProject.key === project.key) currentSessions.push(labeled);
  }
  const recent = (left: SessionInfo, right: SessionInfo) => right.modified.getTime() - left.modified.getTime();
  return { currentSessions: currentSessions.sort(recent), allSessions: allSessions.sort(recent), memorySessions };
}

export async function readMemoryHistorySnapshot(session: MemoryHistorySession): Promise<MemoryHistorySnapshot> {
  const diagnostics: string[] = [];
  let metadata = session.memory.metadata;
  let messages: MemoryHistorySnapshot['messages'] = [];
  if (!validMemoryRunId(session.id)) throw new Error('Invalid memory run ID.');
  try {
    await requireDirectory(dirname(session.path));
    const { text, truncated } = await readBoundedFile(session.path, MAX_TRANSCRIPT_BYTES);
    if (truncated) diagnostics.push('Transcript preview truncated at 16 MiB. The retained file is unchanged.');
    const parsed = parseSessionEntries(text);
    if (parsed.length < text.split('\n').filter((line) => line.trim()).length) {
      diagnostics.push('Incomplete or malformed JSONL lines were skipped.');
    }
    const header = parsed[0];
    if (!header || header.type !== 'session' || header.id !== session.id || header.cwd !== session.cwd) {
      throw new Error('Transcript identity does not match the selected session.');
    }
    const entries: SessionEntry[] = [];
    const effectiveParents = new Map<string, string | null>();
    for (const entry of parsed.slice(1)) {
      if (!entry || typeof entry !== 'object' || entry.type === 'session' || typeof entry.id !== 'string'
        || typeof entry.timestamp !== 'string' || effectiveParents.has(entry.id)
        || (entry.parentId !== null && (typeof entry.parentId !== 'string' || !effectiveParents.has(entry.parentId)))) {
        diagnostics.push('Invalid transcript entries were skipped.');
        continue;
      }
      const effectiveParent = entry.parentId === null ? null : effectiveParents.get(entry.parentId)!;
      if ((entry.type === 'message' && !safeStoredMessage(entry.message))
        || (entry.type === 'custom_message' && !safeMessageContent(entry.content))) {
        effectiveParents.set(entry.id, effectiveParent);
        diagnostics.push('Invalid transcript entries were skipped.');
        continue;
      }
      const accepted = entry.parentId === effectiveParent ? entry : { ...entry, parentId: effectiveParent };
      effectiveParents.set(entry.id, entry.id);
      entries.push(accepted);
      if (entry.type === 'custom' && entry.customType === MEMORY_RUN_ENTRY) {
        const value = memoryMetadata(entry.data, session);
        if (value) metadata = value;
        else diagnostics.push('Invalid memory metadata was ignored.');
      }
    }
    const directlyRecoverable = entries.flatMap((entry) => entry.type === 'message' && safeStoredMessage(entry.message)
      ? [entry.message]
      : []);
    try {
      messages = buildSessionContext(entries).messages;
      if (messages.length === 0 && directlyRecoverable.length > 0) {
        diagnostics.push('Malformed transcript context was partially recovered.');
        messages = directlyRecoverable;
      }
    } catch {
      diagnostics.push('Malformed transcript context was partially recovered.');
      messages = directlyRecoverable;
    }
  } catch (error) {
    diagnostics.push(`Transcript unavailable: ${safeFileError(error)}`);
  }
  try {
    const value = await readMemoryManifestMetadata(session);
    if (value) metadata = value;
    else diagnostics.push('Invalid diagnostic manifest was ignored.');
  } catch (error) {
    diagnostics.push(`Diagnostic manifest unavailable: ${safeFileError(error)}`);
  }
  if (!metadata) diagnostics.push('No memory run metadata was retained.');
  return { session, ...(metadata ? { metadata } : {}), messages, diagnostics: [...new Set(diagnostics)] };
}

async function listMemorySessions(memoryDir: string): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  for (const file of await readdir(memoryDir, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
    const session = await readMemoryCatalogEntry(join(memoryDir, file.name)).catch(() => undefined);
    if (session) sessions.push(session);
  }
  return sessions;
}

async function readMemoryCatalogEntry(path: string): Promise<SessionInfo | undefined> {
  const { text, truncated } = await readBoundedFile(path, MAX_CATALOG_BYTES);
  const lines = text.split('\n');
  const header = parseRecord(lines[0]);
  if (!header || header.type !== 'session' || typeof header.id !== 'string' || !validMemoryRunId(header.id)
    || typeof header.cwd !== 'string' || header.cwd.length > 4_096 || header.cwd.includes('\0')) return undefined;
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) return undefined;
  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = '';
  let allMessagesText = '';
  const body = lines.slice(1);
  if (truncated && body.length > 0) body.pop();
  for (const line of body) {
    const entry = parseRecord(line);
    if (!entry) continue;
    if (entry.type === 'session_info') {
      name = typeof entry.name === 'string' ? safeCatalogText(entry.name, 512) || undefined : undefined;
      continue;
    }
    if (entry.type !== 'message') continue;
    messageCount += 1;
    const message = parseRecord(entry.message);
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const content = messageText(message.content);
    if (!content) continue;
    if (!firstMessage && message.role === 'user') firstMessage = content.slice(0, 2_000);
    if (allMessagesText.length < MAX_CATALOG_TEXT) {
      allMessagesText = `${allMessagesText} ${content}`.trim().slice(0, MAX_CATALOG_TEXT);
    }
  }
  const headerTime = typeof header.timestamp === 'string' ? Date.parse(header.timestamp) : Number.NaN;
  const created = Number.isFinite(headerTime) ? new Date(headerTime) : info.birthtimeMs > 0 ? info.birthtime : info.mtime;
  return {
    path,
    id: header.id,
    cwd: header.cwd,
    ...(name ? { name } : {}),
    ...(typeof header.parentSession === 'string' ? { parentSessionPath: header.parentSession } : {}),
    created,
    modified: info.mtime,
    messageCount,
    firstMessage: firstMessage || '(no messages)',
    allMessagesText,
  };
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    if (!value.trim()) return undefined;
    try {
      return parseRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return safeCatalogText(content, MAX_CATALOG_TEXT);
  if (!Array.isArray(content)) return '';
  return safeCatalogText(content.flatMap((block) => {
    const value = parseRecord(block);
    return value?.type === 'text' && typeof value.text === 'string' ? [value.text] : [];
  }).join(' '), MAX_CATALOG_TEXT);
}

function safeCatalogText(value: string, limit: number): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit);
}

function safeStoredMessage(value: unknown): boolean {
  const message = parseRecord(value);
  return message !== undefined && typeof message.role === 'string' && safeMessageContent(message.content);
}

function safeMessageContent(value: unknown): boolean {
  if (typeof value === 'string') return true;
  return Array.isArray(value) && value.every((block) => {
    const content = parseRecord(block);
    return content !== undefined && typeof content.type === 'string';
  });
}

async function readMemoryManifestMetadata(session: MemoryHistorySession): Promise<MemoryRunMetadata | undefined> {
  let directory = dirname(session.memory.manifestPath);
  for (let depth = 0; depth < 6; depth += 1) {
    await requireDirectory(directory);
    directory = dirname(directory);
  }
  const { text, truncated } = await readBoundedFile(session.memory.manifestPath, MAX_MANIFEST_BYTES);
  return truncated ? undefined : memoryMetadata(JSON.parse(text), session);
}

export function safeMemoryText(value: unknown): string {
  return stripTerminalSequences(sanitizeMemoryDiagnostic(value)).replace(/\s+/gu, ' ').trim().slice(0, 500);
}

export function validMemoryRunId(value: string): boolean {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
}

function memoryMetadata(value: unknown, session: MemoryHistorySession): MemoryRunMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Partial<MemoryRunMetadata>;
  if (data.version !== 1 || data.kind !== 'memory' || data.sessionId !== session.id
    || data.sessionFile !== basename(session.path) || data.projectKey !== session.memory.project.key
    || data.projectRoot !== session.cwd || typeof data.startedAt !== 'string'
    || !['started', 'worker_completed', 'completed', 'failed', 'cancelled', 'blocked', 'interrupted'].includes(data.status ?? '')
    || !['materialize', 'model', 'validate', 'publish'].includes(data.phase ?? '')
    || !Array.isArray(data.checkpoints) || typeof data.baseFingerprint !== 'string'
    || (data.error !== undefined && typeof data.error !== 'string')
    || (data.finishedAt !== undefined && typeof data.finishedAt !== 'string')
    || (data.model !== undefined && (!data.model || typeof data.model.provider !== 'string' || typeof data.model.id !== 'string'))) {
    return undefined;
  }
  return data as MemoryRunMetadata;
}

async function requireDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Expected a regular diagnostic directory.');
}

async function readBoundedFile(path: string, limit: number): Promise<{ text: string; truncated: boolean }> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Expected a regular diagnostic file.');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await file.stat()).isFile()) throw new Error('Expected a regular diagnostic file.');
    const buffer = Buffer.alloc(Math.min(info.size, limit) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return { text: buffer.subarray(0, Math.min(length, limit)).toString('utf8'), truncated: length > limit };
  } finally {
    await file.close();
  }
}

function safeFileError(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    if (error.code === 'ENOENT') return 'file is missing or has been pruned.';
    if (error.code === 'EACCES' || error.code === 'EPERM') return 'permission denied.';
  }
  return error instanceof SyntaxError ? 'invalid JSON.' : safeMemoryText(error instanceof Error ? error.message : 'read failed.');
}
