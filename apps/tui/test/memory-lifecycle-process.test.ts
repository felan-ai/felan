import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionContext, FelanExtensionAPI, ModelRuntime } from '@felan-ai/agent-core';
import { digestActiveBranch, type SessionCheckpoint } from '@felan-ai/ext-memory';
import { createLocalMemoryControlExtension } from '../src/memory/control.js';
import { LocalMemoryCoordinator } from '../src/memory/coordinator.js';
import { listLocalSessionHistory, readMemoryHistorySnapshot } from '../src/memory/history.js';
import { resolveLocalMemoryProject } from '../src/memory/project.js';
import { LocalMemoryStore } from '../src/memory/store.js';

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('multi-process memory lifecycle', () => {
  it('shares three failures, durable disablement, inspection, warning, and explicit recovery across processes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'felan-memory-process-'));
    temporaryPaths.push(root);
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    const sessionDir = join(root, 'configured-sessions');
    const sessionFile = join(root, 'source.jsonl');
    const callLog = join(root, 'calls.log');
    const barrierPath = join(root, 'workers.ready');
    await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir), writeFile(callLog, ''), writeFile(barrierPath, '')]);
    const entries: Record<string, unknown>[] = [{
      type: 'message', id: 'leaf-1', parentId: null, timestamp: '2026-09-01T12:00:00.000Z',
      message: { role: 'user', content: 'Remember the durable process fixture.' },
    }];
    const checkpoint = await writeCheckpoint(sessionFile, cwd, entries);
    const failedConfig = await writeWorkerConfig(root, {
      cwd, agentDir, sessionDir, callLog, checkpoint, action: 'run', outcome: 'fail',
      automatic: true, retryDelaysMs: [50, 100], barrierPath, barrierParticipants: 2,
    });

    const workers = await Promise.allSettled([runWorker(failedConfig), runWorker(failedConfig)]);
    expect(workers).toEqual([
      expect.objectContaining({ status: 'fulfilled' }),
      expect.objectContaining({ status: 'fulfilled' }),
    ]);

    const failedCalls = await modelCalls(callLog);
    expect(failedCalls).toHaveLength(3);
    const store = new LocalMemoryStore(agentDir, await resolveLocalMemoryProject(cwd));
    const disabledControl = await store.readControl();
    expect(disabledControl).toMatchObject({
      consecutiveFailures: 3,
      autoDisabled: { runId: expect.any(String) },
      lastDisabledRunId: expect.any(String),
    });
    expect(await store.status()).toMatchObject({ pending: { source: { checkpoint } } });

    const history = await listLocalSessionHistory({ cwd, agentDir, sessionDir, memoryOnly: true });
    expect(history.currentSessions).toHaveLength(3);
    expect([...history.memorySessions.values()].map((session) => session.memory.metadata?.status)).toEqual([
      'failed', 'failed', 'failed',
    ]);
    for (const session of history.memorySessions.values()) {
      const before = await readFile(session.path, 'utf8');
      expect((await readMemoryHistorySnapshot(session)).metadata).toMatchObject({ status: 'failed' });
      expect(await readFile(session.path, 'utf8')).toBe(before);
    }

    const coordinator = new LocalMemoryCoordinator({
      agentDir, sessionDir, modelRuntime: {} as ModelRuntime, recover: false, debounceMs: 60_000,
    });
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    createLocalMemoryControlExtension({ coordinator, agentDir })({
      registerCommand: () => {},
      on: (name, handler) => handlers.set(name, handler),
    } as unknown as FelanExtensionAPI);
    const notify = vi.fn();
    const setStatus = vi.fn();
    const context = {
      cwd, mode: 'tui', hasUI: true,
      sessionManager: { getSessionId: () => 'root-session' },
      ui: { notify, setStatus },
    } as unknown as ExtensionContext;
    await handlers.get('session_start')!({}, context);
    await handlers.get('session_start')!({}, context);
    expect(setStatus).toHaveBeenLastCalledWith('memory', 'Memory: disabled');
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]?.[0]).toContain('/memory retry');
    await coordinator.dispose();

    entries.push({
      type: 'message', id: 'leaf-2', parentId: 'leaf-1', timestamp: '2026-09-01T12:02:00.000Z',
      message: { role: 'user', content: 'This newer checkpoint must remain pending.' },
    });
    const newer = await writeCheckpoint(sessionFile, cwd, entries);
    const disabledConfig = await writeWorkerConfig(root, {
      cwd, agentDir, sessionDir, callLog, checkpoint: newer, action: 'run', outcome: 'fail', automatic: true,
    });
    await runWorker(disabledConfig);
    expect(await modelCalls(callLog)).toHaveLength(3);
    expect(await store.readControl()).toMatchObject({ consecutiveFailures: 3, autoDisabled: { runId: expect.any(String) } });

    const recoveryConfig = await writeWorkerConfig(root, {
      cwd, agentDir, sessionDir, callLog, checkpoint: newer, action: 'retry', outcome: 'success',
    });
    await runWorker(recoveryConfig);
    expect(await modelCalls(callLog)).toHaveLength(4);
    const recoveredControl = await store.readControl();
    expect(recoveredControl).toMatchObject({
      consecutiveFailures: 0,
      lastDisabledRunId: disabledControl.autoDisabled!.runId,
    });
    expect(recoveredControl.autoDisabled).toBeUndefined();
    expect(await store.status()).toMatchObject({ pending: {}, processed: { source: { checkpoint: newer } } });
    const recoveredHistory = await listLocalSessionHistory({ cwd, agentDir, sessionDir, memoryOnly: true });
    expect([...recoveredHistory.memorySessions.values()].map((session) => session.memory.metadata?.status).sort()).toEqual([
      'completed', 'failed', 'failed', 'failed',
    ]);
  }, 30_000);

  it('reconciles an abruptly terminated process before automatically continuing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'felan-memory-crash-process-'));
    temporaryPaths.push(root);
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    const sessionDir = join(root, 'sessions');
    const sessionFile = join(root, 'source.jsonl');
    const callLog = join(root, 'calls.log');
    await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir), writeFile(callLog, '')]);
    const checkpoint = await writeCheckpoint(sessionFile, cwd, [{
      type: 'message', id: 'leaf-1', parentId: null, timestamp: '2026-09-01T12:00:00.000Z',
      message: { role: 'user', content: 'Recover this process after a hard stop.' },
    }]);
    const crashed = await writeWorkerConfig(root, {
      cwd, agentDir, sessionDir, callLog, checkpoint, action: 'run', outcome: 'success',
      automatic: true, crashOnModel: true, leaseStaleMs: 2_000,
    });

    await expect(runWorker(crashed)).rejects.toThrow();
    const store = new LocalMemoryStore(agentDir, await resolveLocalMemoryProject(cwd));
    expect((await store.readControl()).activeAttempt).toMatchObject({ runId: expect.any(String) });
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const recovered = await writeWorkerConfig(root, {
      cwd, agentDir, sessionDir, callLog, checkpoint, action: 'run', outcome: 'success',
      automatic: true, leaseStaleMs: 2_000,
    });

    await runWorker(recovered);

    expect(await modelCalls(callLog)).toHaveLength(2);
    expect(await store.readControl()).toMatchObject({ consecutiveFailures: 0, lastOutcome: { status: 'success' } });
    expect((await store.readControl()).activeAttempt).toBeUndefined();
    expect(await store.status()).toMatchObject({ pending: {}, processed: { source: { checkpoint } } });
    const history = await listLocalSessionHistory({ cwd, agentDir, sessionDir, memoryOnly: true });
    expect([...history.memorySessions.values()].map((session) => session.memory.metadata?.status).sort()).toEqual([
      'cancelled', 'completed',
    ]);
  }, 30_000);
});

async function writeCheckpoint(
  sessionFile: string,
  cwd: string,
  entries: readonly Record<string, unknown>[],
): Promise<SessionCheckpoint> {
  await writeFile(sessionFile, [
    JSON.stringify({ type: 'session', version: 3, id: 'source', timestamp: '2026-09-01T12:00:00.000Z', cwd }),
    ...entries.map((entry) => JSON.stringify(entry)),
    '',
  ].join('\n'));
  return {
    sessionId: 'source',
    sessionFile,
    leafId: String(entries.at(-1)!.id),
    transcriptDigest: digestActiveBranch(entries),
  };
}

async function writeWorkerConfig(root: string, config: Record<string, unknown>): Promise<string> {
  const path = join(root, `worker-${crypto.randomUUID()}.json`);
  await writeFile(path, JSON.stringify(config));
  return path;
}

async function runWorker(configPath: string): Promise<void> {
  const packageDirectory = dirname(fileURLToPath(import.meta.resolve('vitest/package.json')));
  const worker = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'memory-process-worker.test.ts');
  await execFileAsync(process.execPath, [
    join(packageDirectory, 'vitest.mjs'), 'run', worker, '--maxWorkers=1', '--pool=threads',
  ], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
    env: { ...process.env, FELAN_MEMORY_PROCESS_CONFIG: configPath },
    maxBuffer: 2 * 1_024 * 1_024,
    timeout: 15_000,
    killSignal: 'SIGKILL',
  });
}

async function modelCalls(path: string): Promise<Array<{ readonly pid: number; readonly at: number }>> {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { pid: number; at: number });
}
