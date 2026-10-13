import { beforeEach as beforeMemoryTest } from "vitest";
import { createMemoryBackend } from './backend.js';
let { listLocalSessionHistory, readMemoryHistorySnapshot, resolveLocalMemoryProject } = createMemoryBackend();
beforeMemoryTest(() => { ({ listLocalSessionHistory, readMemoryHistorySnapshot, resolveLocalMemoryProject } = createMemoryBackend()); });
import { sanitizeMemoryDiagnostic } from '../../src/diagnostics.js';
import type { MemoryRunMetadata, MemoryHistorySession } from '../../src/index.js';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  SessionManager,
  type SessionInfo,
} from '@felan-ai/agent-core';
import type { ExtensionContext } from '@felan-ai/agent-core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { safeMemoryText, validMemoryRunId } from './backend.js';
import { localMemoryProjectDirectory } from './backend.js';
import { MEMORY_RUN_ENTRY } from './backend.js';

const temporaryPaths: string[] = [];
const execFileAsync = promisify(execFile);



afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('local memory history', () => {
  it('adds standard retained memory sessions to current and all history with Memory labels', async () => {
    const fixture = await memoryFixture();

    const history = await listLocalSessionHistory(fixture);
    const retained = history.memorySessions.get(fixture.memoryFile);

    expect(history.currentSessions.map((session) => session.path)).toEqual(expect.arrayContaining([
      fixture.normal.getSessionId(),
      fixture.memoryFile,
    ]));
    expect(history.allSessions.map((session) => session.path)).toEqual(expect.arrayContaining([
      fixture.normal.getSessionId(),
      fixture.memoryFile,
    ]));
    expect(retained).toMatchObject({
      id: fixture.memory.getSessionId(),
      cwd: fixture.project.canonicalRoot,
      name: 'Memory: workspace · failed',
      memory: { metadata: { status: 'failed', phase: 'model' } },
    });
    expect(retained?.allMessagesText).toContain('Memory: workspace · failed');

    const snapshot = await readMemoryHistorySnapshot(retained!);
    expect(snapshot.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(snapshot.metadata).toMatchObject({ status: 'failed', error: sanitizeMemoryDiagnostic(fixture.error) });
  });

  it('keeps retained runs project-scoped', async () => {
    const current = await memoryFixture();
    const otherRoot = await temporaryDirectory('felan-memory-other-');
    const otherProject = join(otherRoot, 'other');
    await mkdir(otherProject);
    const other = SessionManager.create(otherProject, join(current.sessionDir, 'memory'));
    other.appendCustomEntry(MEMORY_RUN_ENTRY, await metadataFor(other, current.agentDir, otherProject));
    appendUser(other, 'Other project memory');
    appendAssistant(other, 'Other project result');

    const history = await listLocalSessionHistory(current);

    expect(history.memorySessions.has(other.getSessionFile()!)).toBe(true);
    expect(history.currentSessions.some((session) => session.path === other.getSessionFile())).toBe(false);
    expect(validMemoryRunId('../run')).toBe(false);
    expect(validMemoryRunId('run_01-AB')).toBe(true);
  });

  it('discovers malformed transcripts from validated headers and preserves earlier messages', async () => {
    const fixture = await memoryFixture();
    const entries = (await readFile(fixture.memoryFile, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const malformedIndex = entries.findIndex((entry) => entry.type === 'message'
      && (entry.message as { role?: unknown } | undefined)?.role === 'assistant');
    const malformed = entries[malformedIndex]!;
    (malformed.message as { content?: unknown }).content = null;
    const recoveredId = 'assistant-after-corruption';
    entries.splice(malformedIndex + 1, 0, {
      type: 'message', id: recoveredId, parentId: malformed.id, timestamp: '2026-09-01T12:00:30.000Z',
      message: {
        role: 'assistant', content: [{ type: 'text', text: 'Response after corruption' }],
        provider: 'openai', model: 'fixture-model', api: 'openai-responses', stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
      },
    });
    for (const entry of entries.slice(malformedIndex + 2)) {
      if (entry.parentId === malformed.id) entry.parentId = recoveredId;
    }
    await writeFile(fixture.memoryFile, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const history = await listLocalSessionHistory(fixture);
    const retained = history.memorySessions.get(fixture.memoryFile);
    expect(retained).toBeDefined();
    const snapshot = await readMemoryHistorySnapshot(retained!);
    expect(snapshot.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(snapshot.metadata).toMatchObject({ status: 'failed' });
    expect(snapshot.diagnostics).toContain('Invalid transcript entries were skipped.');
  });

  it.skipIf(process.platform === 'win32')('skips symlinks and FIFOs during bounded history discovery', async () => {
    const fixture = await memoryFixture();
    const memoryDir = join(fixture.sessionDir, 'memory');
    const outside = join(dirname(memoryDir), 'outside.jsonl');
    await writeFile(outside, await readFile(fixture.memoryFile));
    await symlink(outside, join(memoryDir, 'linked.jsonl'));
    await execFileAsync('mkfifo', [join(memoryDir, 'pipe.jsonl')]);
    const oversized = join(memoryDir, 'oversized.jsonl');
    await writeFile(oversized, `${JSON.stringify({
      type: 'session', version: 3, id: 'oversized', timestamp: '2026-09-01T12:00:00.000Z', cwd: fixture.cwd,
    })}\n${'x'.repeat(512 * 1_024)}`);

    const history = await listLocalSessionHistory(fixture);

    expect([...history.memorySessions.keys()]).toContain(fixture.memoryFile);
    expect([...history.memorySessions.keys()]).toContain(oversized);
    expect([...history.memorySessions.keys()]).not.toContain(join(memoryDir, 'linked.jsonl'));
    expect([...history.memorySessions.keys()]).not.toContain(join(memoryDir, 'pipe.jsonl'));
  });

  it('reports early, missing, malformed, and truncated artifacts without mutating them', async () => {
    const root = await temporaryDirectory();
    const projectRoot = join(root, 'workspace');
    const sessionDir = join(root, 'sessions');
    const memoryDir = join(sessionDir, 'memory');
    const agentDir = join(root, 'agent');
    await Promise.all([mkdir(projectRoot), mkdir(memoryDir, { recursive: true })]);
    const project = await resolveLocalMemoryProject(projectRoot);
    const id = 'run-truncated';
    const path = join(memoryDir, `${id}.jsonl`);
    const header = JSON.stringify({
      type: 'session', version: 3, id, timestamp: '2026-09-01T12:00:00.000Z', cwd: project.canonicalRoot,
    });
    await writeFile(path, `${header}\n{"type":"message","id":"entry-1","parentId":null,"message":{"role":"user","content":"${'x'.repeat(16 * 1_024 * 1_024)}\n`);
    const before = (await readFile(path)).byteLength;
    const session: MemoryHistorySession = {
      path,
      id,
      cwd: project.canonicalRoot,
      
      
      created: new Date('2026-09-01T12:00:00.000Z'),
      modified: new Date('2026-09-01T12:00:00.000Z'),
      messageCount: 0,
      firstMessage: '(no messages)',
      allMessagesText: '',
      memory: {
        project,
        manifestPath: join(localMemoryProjectDirectory(agentDir, project), 'runs', id, 'manifest.json'),
      },
    };

    const snapshot = await readMemoryHistorySnapshot(session);

    expect(snapshot.messages).toEqual([]);
    expect(snapshot.metadata).toBeUndefined();
    expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
      'Transcript preview truncated at 16 MiB. The retained file is unchanged.',
      'Incomplete or malformed JSONL lines were skipped.',
      'Diagnostic manifest unavailable: file is missing or has been pruned.',
      'No memory run metadata was retained.',
    ]));
    expect((await readFile(path)).byteLength).toBe(before);

    await rm(path);
    const missing = await readMemoryHistorySnapshot(session);
    expect(missing.diagnostics).toEqual(expect.arrayContaining([
      'Transcript unavailable: file is missing or has been pruned.',
      'Diagnostic manifest unavailable: file is missing or has been pruned.',
    ]));
  });

  it('sanitizes untrusted diagnostic text before presentation', () => {
    const rendered = safeMemoryText(`Bearer abcdefghijklmnop\u001b]8;;https://example.test\u0007click\u001b]8;;\u0007 ${'x'.repeat(600)}`);

    expect(rendered).toContain('Bearer [REDACTED_TOKEN]');
    expect(rendered).not.toContain('\u001b');
    expect(rendered).not.toContain('abcdefghijklmnop');
    expect(rendered.length).toBeLessThanOrEqual(500);
  });
});

async function memoryFixture() {
  const root = await temporaryDirectory();
  const projectRoot = join(root, 'workspace');
  const sessionDir = join(root, 'sessions');
  const memoryDir = join(sessionDir, 'memory');
  const agentDir = join(root, 'agent');
  await Promise.all([mkdir(projectRoot), mkdir(memoryDir, { recursive: true })]);
  const project = await resolveLocalMemoryProject(projectRoot);
  const normal = SessionManager.create(project.canonicalRoot, sessionDir);
  appendUser(normal, 'Ordinary request');
  appendAssistant(normal, 'Ordinary response');
  const memory = SessionManager.create(project.canonicalRoot, memoryDir);
  const memoryFile = memory.getSessionFile()!;
  const error = 'Bearer abcdefghijklmnop\u001b]8;;https://example.test\u0007hidden\u001b]8;;\u0007';
  const metadata: MemoryRunMetadata = {
    ...await metadataFor(memory, agentDir, project.canonicalRoot),
    status: 'started',
    phase: 'materialize',
  };
  memory.appendSessionInfo('Memory: workspace');
  memory.appendCustomEntry(MEMORY_RUN_ENTRY, metadata);
  appendUser(memory, 'Retained request');
  appendAssistant(memory, 'Retained response');
  const finished: MemoryRunMetadata = {
    ...metadata,
    status: 'failed',
    phase: 'model',
    finishedAt: '2026-09-01T12:01:00.000Z',
    error,
  };
  memory.appendCustomEntry(MEMORY_RUN_ENTRY, finished);
  const runDirectory = join(localMemoryProjectDirectory(agentDir, project), 'runs', memory.getSessionId());
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, 'manifest.json'), JSON.stringify(finished));
  return {
    cwd: project.canonicalRoot,
    projectRoot,
    agentDir,
    sessionDir,
    project,
    normal,
    normalFile: normal.getSessionFile()!,
    memory,
    memoryFile,
    error,
  };
}

async function metadataFor(
  session: SessionManager,
  _agentDir: string,
  projectRoot: string,
): Promise<MemoryRunMetadata> {
  const project = await resolveLocalMemoryProject(projectRoot);
  return {
    version: 1,
    kind: 'memory',
    sessionId: session.getSessionId(),
    sessionFile: basename(session.getSessionFile()!),
    projectKey: project.key,
    projectRoot: project.canonicalRoot,
    startedAt: '2026-09-01T12:00:00.000Z',
    status: 'completed',
    phase: 'publish',
    checkpoints: [],
    baseFingerprint: '1'.repeat(64),
  };
}

function appendUser(session: SessionManager, text: string): void {
  session.appendMessage({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() });
}

function appendAssistant(session: SessionManager, text: string): void {
  session.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text }],
    provider: 'openai',
    model: 'fixture-model',
    api: 'openai-responses',
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
}

async function temporaryDirectory(prefix = 'felan-memory-history-'): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}
