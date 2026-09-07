import { lstat, mkdtemp, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager, type ModelRuntime } from '@felan-ai/agent-core';
import { digestActiveBranch } from '@felan-ai/ext-memory';
import { LocalMemoryRun, memoryRunUsage } from '../src/memory/run.js';
import { LocalMemoryCoordinator } from '../src/memory/coordinator.js';
import { localMemoryProjectDirectory, resolveLocalMemoryProject } from '../src/memory/project.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'felan-memory-run-'));
  roots.push(root);
  const projectRoot = join(root, 'workspace');
  await mkdir(projectRoot);
  return {
    root,
    projectRoot,
    projectDirectory: join(root, 'project-memory'),
    sessionDirectory: join(root, 'sessions', 'memory'),
    projectKey: '1'.repeat(64),
    checkpoints: [],
    baseFingerprint: '2'.repeat(64),
  };
}

describe('retained memory runs', () => {
  it('uses standard sessions with original project identity and private, separate working files', async () => {
    const options = await fixture();
    const run = await LocalMemoryRun.create(options);
    const path = join(options.sessionDirectory, run.metadata.sessionFile);
    const sessions = await SessionManager.list(options.projectRoot, options.sessionDirectory);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: run.metadata.sessionId, cwd: options.projectRoot });
    expect(run.workspace).not.toBe(options.projectRoot);
    expect(run.sessionManager.buildSessionContext().messages).toEqual([]);
    const reopened = SessionManager.open(path, options.sessionDirectory);
    expect(reopened.getEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'custom', customType: 'felan-memory-run', data: expect.objectContaining({ kind: 'memory' }) }),
    ]));
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(run.directory)).mode & 0o777).toBe(0o700);
    }
  });

  it('retains useful error details while redacting credentials', async () => {
    const options = await fixture();
    const run = await LocalMemoryRun.create(options);
    await run.record({ phase: 'validate' });
    await run.finish('failed', new Error('Broken link: pages/a.md; apiKey=private-value Bearer private-access-token'));
    const record = await readFile(join(run.directory, 'manifest.json'), 'utf8');
    expect(record).toContain('Broken link: pages/a.md');
    expect(record).not.toContain('private-value');
    expect(record).not.toContain('private-access-token');
    expect(JSON.parse(record)).toMatchObject({ status: 'failed', phase: 'validate', finishedAt: expect.any(String) });
  });

  it('appends ordinary messages without rewriting or duplicating the pre-persisted header', async () => {
    const options = await fixture();
    const run = await LocalMemoryRun.create(options);
    run.sessionManager.appendMessage({ role: 'user', content: 'Process staged memory.', timestamp: Date.now() });
    run.sessionManager.appendMessage({
      role: 'assistant', content: [{ type: 'text', text: 'The memory is ready.' }],
      provider: 'openai-codex', model: 'test-model', api: 'openai-responses',
      usage: { input: 4, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 7,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: Date.now(),
    });
    await run.finish('completed');
    const text = await readFile(join(options.sessionDirectory, run.metadata.sessionFile), 'utf8');
    const entries = text.trim().split('\n').map((line) => JSON.parse(line) as { type: string });
    expect(entries.filter(({ type }) => type === 'session')).toHaveLength(1);
    expect(entries.filter(({ type }) => type === 'message')).toHaveLength(2);
    const reopened = SessionManager.open(join(options.sessionDirectory, run.metadata.sessionFile));
    expect(reopened.buildSessionContext().messages).toHaveLength(2);
  });

  it('distinguishes unknown usage and retains both pre-compaction and compaction inference', () => {
    expect(memoryRunUsage([])).toBeUndefined();
    const entries = [
      { type: 'message', message: { role: 'assistant', usage: { input: 12, output: 3, totalTokens: 15, cost: { total: 0.1 } } } },
      { type: 'compaction', usage: { input: 2, output: 1, totalTokens: 3, cost: { total: 0.1 } } },
      { type: 'message', message: { role: 'assistant', usage: { input: 5, output: 2, totalTokens: 7, cost: { total: 0.2 } } } },
    ] as unknown as ReturnType<SessionManager['getEntries']>;
    expect(memoryRunUsage(entries)).toMatchObject({ input: 19, output: 6, totalTokens: 25 });
    expect(memoryRunUsage(entries)?.costUsd).toBeCloseTo(0.4);
  });

  it('enforces the terminal run count without needing another attempt to start', async () => {
    const options = await fixture();
    for (let index = 0; index < 51; index += 1) {
      const run = await LocalMemoryRun.create(options);
      await run.finish('completed');
    }
    expect(await readdir(join(options.projectDirectory, 'runs'))).toHaveLength(50);
    expect(await readdir(options.sessionDirectory)).toHaveLength(50);
  }, 15_000);

  it('reconciles a pre-attempt crash without consuming the retry budget or requiring pending work', async () => {
    const options = await fixture();
    const agentDir = join(options.root, 'agent');
    const project = await resolveLocalMemoryProject(options.projectRoot);
    const run = await LocalMemoryRun.create({
      ...options,
      projectDirectory: localMemoryProjectDirectory(agentDir, project),
      projectKey: project.key,
    });
    const coordinator = new LocalMemoryCoordinator({
      agentDir,
      sessionDir: join(options.root, 'sessions'),
      modelRuntime: {} as ModelRuntime,
      enabled: false,
      recover: false,
    });
    try {
      await coordinator.status(options.projectRoot);
      expect(JSON.parse(await readFile(join(run.directory, 'manifest.json'), 'utf8'))).toMatchObject({
        status: 'cancelled',
        finishedAt: expect.any(String),
        error: 'The previous memory worker ended before completion was confirmed; evidence remains pending',
      });
      const metadata = SessionManager.open(
        join(options.sessionDirectory, run.metadata.sessionFile),
        options.sessionDirectory,
        options.projectRoot,
      ).getEntries().filter((entry) => entry.type === 'custom' && entry.customType === 'felan-memory-run').at(-1);
      expect(metadata).toMatchObject({ data: { status: 'cancelled', finishedAt: expect.any(String) } });
      expect(await coordinator.status(options.projectRoot)).toMatchObject({ consecutiveFailures: 0, pendingCheckpoints: 0 });
    } finally {
      await coordinator.dispose();
    }
  });

  it('validates transcript ownership read-only before reconciling metadata', async () => {
    const options = await fixture();
    const run = await LocalMemoryRun.create(options);
    const sessionPath = join(options.sessionDirectory, run.metadata.sessionFile);
    const unrelated = JSON.stringify({
      type: 'session', version: 3, id: run.metadata.sessionId, timestamp: new Date().toISOString(), cwd: options.projectRoot,
    });
    await writeFile(sessionPath, unrelated);

    await expect(LocalMemoryRun.reconcile(options, {
      runId: run.metadata.sessionId, status: 'failure', at: new Date().toISOString(),
    })).rejects.toThrow('Retained memory session is incomplete');
    expect(await readFile(sessionPath, 'utf8')).toBe(unrelated);
    await writeFile(sessionPath, `${unrelated}\n`);
    await expect(LocalMemoryRun.reconcile(options, {
      runId: run.metadata.sessionId, status: 'failure', at: new Date().toISOString(),
    })).rejects.toThrow('Retained memory session ownership is unverified');
    expect(await readFile(sessionPath, 'utf8')).toBe(`${unrelated}\n`);
  });

  it('refuses oversized reconciliation transcripts before opening a SessionManager', async () => {
    const options = await fixture();
    const run = await LocalMemoryRun.create(options);
    const sessionPath = join(options.sessionDirectory, run.metadata.sessionFile);
    const file = await open(sessionPath, 'a');
    await file.truncate(17 * 1_024 * 1_024);
    await file.close();
    const before = await stat(sessionPath);

    await expect(LocalMemoryRun.reconcile(options, {
      runId: run.metadata.sessionId, status: 'failure', at: new Date().toISOString(),
    })).rejects.toThrow('Invalid or oversized retained memory session file');
    expect((await stat(sessionPath)).size).toBe(before.size);
  });

  it('preserves failed worker session and manifest after coordinator cleanup', async () => {
    const options = await fixture();
    const source = join(options.root, 'source.jsonl');
    const entries = [{
      type: 'message', id: 'leaf', parentId: null, timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: 'Keep focused changes.' },
    }];
    await writeFile(source, [
      JSON.stringify({ type: 'session', version: 3, id: 'source', cwd: options.projectRoot }),
      ...entries.map((entry) => JSON.stringify(entry)), '',
    ].join('\n'));
    let run: LocalMemoryRun | undefined;
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(options.root, 'agent'), sessionDir: join(options.root, 'sessions'),
      modelRuntime: {} as ModelRuntime, recover: false,
      dreamRunner: async (input) => { run = input.run; throw new Error('Provider unavailable: retry later'); },
    });
    try {
      await coordinator.recordCheckpoint(options.projectRoot, {
        sessionId: 'source', sessionFile: source, leafId: 'leaf', transcriptDigest: digestActiveBranch(entries),
      });
      expect(await coordinator.runNow(options.projectRoot)).toMatchObject({ state: 'scheduled', pendingCheckpoints: 1 });
      expect(run).toBeDefined();
      expect(run!.metadata).toMatchObject({ status: 'failed', phase: 'model', error: 'Provider unavailable: retry later' });
      await expect(lstat(run!.workspace)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(run!.directory, 'manifest.json'), 'utf8')).toContain('source');
      expect(await readdir(options.sessionDirectory)).toHaveLength(1);
      expect(await SessionManager.listAll(join(options.root, 'sessions'))).toHaveLength(0);
    } finally {
      await coordinator.dispose();
    }
  });

  it('does not relabel committed memory as failed when its final diagnostic write fails', async () => {
    const options = await fixture();
    const source = join(options.root, 'source.jsonl');
    const entries = [{
      type: 'message', id: 'leaf', parentId: null, timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: 'Keep focused changes.' },
    }];
    await writeFile(source, [
      JSON.stringify({ type: 'session', version: 3, id: 'source', cwd: options.projectRoot }),
      ...entries.map((entry) => JSON.stringify(entry)), '',
    ].join('\n'));
    const finish = vi.spyOn(LocalMemoryRun.prototype, 'finish').mockRejectedValue(new Error('Diagnostic disk write failed'));
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(options.root, 'agent'), sessionDir: join(options.root, 'sessions'),
      modelRuntime: {} as ModelRuntime, recover: false,
      dreamRunner: async (input) => input.baseSnapshot,
    });
    try {
      await coordinator.recordCheckpoint(options.projectRoot, {
        sessionId: 'source', sessionFile: source, leafId: 'leaf', transcriptDigest: digestActiveBranch(entries),
      });
      expect(await coordinator.runNow(options.projectRoot)).toMatchObject({
        state: 'idle', pendingCheckpoints: 0,
        message: 'Memory was published, but its diagnostics could not be fully saved',
      });
      expect(finish).toHaveBeenCalledExactlyOnceWith('completed');
    } finally {
      await coordinator.dispose();
    }
  });
});
