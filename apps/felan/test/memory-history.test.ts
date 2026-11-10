import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { HostAgentRuntime, type SessionsService } from '@felan-ai/agent-core';
import { listLocalSessionHistory as listHistory, localMemoryProjectDirectory, resolveLocalMemoryProject as resolveProject, MEMORY_RUN_ENTRY, type MemoryRunMetadata } from '@felan-ai/ext-memory';
import { afterEach, describe, expect, it } from 'vitest';
const environment = { runtime: new HostAgentRuntime('/', { pathAccess: 'host', sessionStorageRoot: tmpdir(), agentStorageRoot: tmpdir() }), sessions: {} as SessionsService };
const listLocalSessionHistory = (options: Parameters<typeof listHistory>[1]) => listHistory(environment, options);
const resolveLocalMemoryProject = (cwd: string) => resolveProject(environment, cwd);

const temporaryPaths: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('local memory history', () => {

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

    const history = await listLocalSessionHistory({ ...fixture, memoryOnly: true });

    expect([...history.memorySessions.keys()]).toContain(fixture.memoryFile);
    expect([...history.memorySessions.keys()]).toContain(oversized);
    expect([...history.memorySessions.keys()]).not.toContain(join(memoryDir, 'linked.jsonl'));
    expect([...history.memorySessions.keys()]).not.toContain(join(memoryDir, 'pipe.jsonl'));
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
