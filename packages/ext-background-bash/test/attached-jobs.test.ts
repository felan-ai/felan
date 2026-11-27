import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostAgentRuntime, type AgentRuntimeProcess } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundBashJobStore } from '../src/job-store.js';
import { BackgroundBashManager } from '../src/process-manager.js';

const roots: string[] = [];
const managers: BackgroundBashManager[] = [];
const processes: AgentRuntimeProcess[] = [];
const decoder = new TextDecoder();
const orphanError = 'Process is not attached to a live root session; its exit status is unavailable.';

afterEach(async () => {
  vi.restoreAllMocks();
  const shutdowns = await Promise.allSettled(managers.splice(0).map((manager) => manager.shutdownInteractive()));
  const disposals = await Promise.allSettled(processes.splice(0).map((process) => process.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  const failures = [...shutdowns, ...disposals].filter((result) => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Attached process fixture cleanup failed');
});

describe('BackgroundBashManager attached jobs', () => {
  it('promotes the same child and persists output before and after promotion', async () => {
    const { runtime, manager } = await createFixture();
    const startedAt = Date.now() - 60_000;
    const command = "printf 'before\n'; while [ ! -f continue ]; do sleep 0.02; done; printf 'after\n'";
    const process = await startProcess(runtime, command);
    expect(decoder.decode((await process.read(0, { waitMs: 1_000 })).output)).toBe('before\n');
    const promotionStart = Date.now();
    const job = await manager.promote(command, process, startedAt);
    const info = JSON.parse(decoder.decode(await runtime.readFile(job.meta.infoPath)));

    expect(info).toMatchObject({ executionMode: 'attached', startedAt, pid: process.pid, status: 'running' });
    expect(info.promotedAt).toBeGreaterThanOrEqual(promotionStart);
    expect(info.promotedAt).toBeLessThanOrEqual(Date.now());
    expect(info).not.toHaveProperty('processToken');
    await expect(runtime.readFile(job.meta.commandPath)).rejects.toThrow();
    await expect(runtime.readFile(job.meta.runnerPath)).rejects.toThrow();
    await expect(manager.tail(job.meta.id)).resolves.toBe('before');
    await runtime.writeFile('continue', new Uint8Array());
    const completed = await manager.wait(job.meta.id, 5);

    expect(completed).toMatchObject({ timedOut: false, job: { status: { status: 'completed', exitCode: 0 } } });
    expect(completed.job.meta.pid).toBe(process.pid);
    expect(decoder.decode(await runtime.readFile(job.meta.logPath))).toBe('before\nafter\n');
  });

  it.each([0, 7])('persists exit code %i when the child exits before adoption', async (exitCode) => {
    const { runtime, manager } = await createFixture();
    const command = `printf done; exit ${exitCode}`;
    const process = await startProcess(runtime, command);
    let snapshot = await process.read(0);
    while (snapshot.running) snapshot = await process.read(snapshot.nextOffset, { waitMs: 1_000 });
    const job = await manager.promote(command, process, Date.now() - 100);

    expect(job.status).toMatchObject({ status: exitCode === 0 ? 'completed' : 'failed', exitCode });
    await expect(manager.tail(job.meta.id)).resolves.toBe('done');
  });

  it('delegates reads and stop across managers after the process status grace period', async () => {
    const { runtime, manager } = await createFixture();
    const process = await startProcess(runtime, 'printf ready; sleep 30');
    await process.read(0, { waitMs: 1_000 });
    const job = await manager.promote('printf ready; sleep 30', process, Date.now());
    const other = createManager(runtime);
    const shell = vi.spyOn(runtime, 'shell').mockRejectedValue(new Error('Unexpected PID probe'));
    const now = vi.spyOn(Date, 'now').mockReturnValue(job.meta.startedAt + 6_000);

    await expect(other.get(job.meta.id)).resolves.toMatchObject({ status: { status: 'running' } });
    expect((await other.list('running')).map((entry) => entry.meta.id)).toEqual([job.meta.id]);
    expect((await other.query({ status: 'running' })).jobs.map((entry) => entry.meta.id)).toEqual([job.meta.id]);
    await expect(other.tail(job.meta.id)).resolves.toBe('ready');
    now.mockRestore();
    await expect(other.stop(job.meta.id)).resolves.toMatchObject({ status: { status: 'killed', signal: 'SIGTERM' } });
    expect((await process.read(0)).running).toBe(false);
    expect(shell).not.toHaveBeenCalled();
  });

  it.each(['shutdownAttached', 'shutdownInteractive'] as const)('%s stops promoted children and persists their status', async (shutdown) => {
    const { runtime, manager } = await createFixture();
    const process = await startProcess(runtime, 'sleep 30');
    const job = await manager.promote('sleep 30', process, Date.now());
    const other = createManager(runtime);
    await manager[shutdown]();

    expect((await process.read(0)).running).toBe(false);
    await expect(other.get(job.meta.id)).resolves.toMatchObject({ status: { status: 'killed', signal: 'SIGTERM' } });
    await expect(manager.readInteractive(job.meta.id)).rejects.toThrow('not found');
  });

  it.each([0, 7])('returns the terminal record when a poll removes the child before stop, exit code %i', async (exitCode) => {
    const { runtime, manager } = await createFixture();
    const command = `while [ ! -f continue ]; do sleep 0.02; done; printf done; exit ${exitCode}`;
    const process = await startProcess(runtime, command);
    const dispose = vi.spyOn(process, 'dispose');
    const job = await manager.promote(command, process, Date.now());
    let completed = job;
    const stopInteractive = manager.stopInteractive.bind(manager);
    vi.spyOn(manager, 'stopInteractive').mockImplementationOnce(async (id, signal) => {
      await runtime.writeFile('continue', new Uint8Array());
      let snapshot = await process.read(0);
      while (snapshot.running) snapshot = await process.read(snapshot.nextOffset, { waitMs: 1_000 });
      completed = await manager.get(id);
      return stopInteractive(id, signal);
    });
    const shell = vi.spyOn(runtime, 'shell').mockRejectedValue(new Error('Unexpected PID probe or signal'));

    const stopped = await manager.stop(job.meta.id);
    expect(stopped).toEqual(completed);
    expect(stopped.status).toMatchObject({ status: exitCode === 0 ? 'completed' : 'failed', exitCode });
    expect(stopped.status.signal).toBeUndefined();
    await expect(manager.tail(job.meta.id)).resolves.toBe('done');
    expect(dispose).toHaveBeenCalledOnce();
    expect(shell).not.toHaveBeenCalled();
  });

  it.each([true, false])('normalizes ownerless jobs without probing PIDs, promotedAt present: %s', async (hasPromotedAt) => {
    const { runtime, manager } = await createFixture();
    const store = new BackgroundBashJobStore(runtime, runtime.storage('session'));
    const job = await store.createJob('orphan', 'attached', {
      startedAt: 1_000, pid: 42424242, ...(hasPromotedAt ? { promotedAt: 10_000 } : {}),
    });
    const referenceTime = hasPromotedAt ? 10_000 : 1_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(referenceTime + 5_000);
    const shell = vi.spyOn(runtime, 'shell').mockRejectedValue(new Error('Unexpected PID probe or signal'));
    await expect(manager.get(job.meta.id)).resolves.toMatchObject({ status: { status: 'running' } });
    now.mockReturnValue(referenceTime + 5_001);
    await expect(manager.get(job.meta.id)).resolves.toMatchObject({ status: { status: 'unknown', error: orphanError } });
    await expect(manager.stop(job.meta.id)).resolves.toMatchObject({ status: { status: 'unknown', error: orphanError } });
    expect(shell).not.toHaveBeenCalled();
  });

  it('marks an ownerless attached job unknown when stopped within the grace period', async () => {
    const { runtime, manager } = await createFixture();
    const store = new BackgroundBashJobStore(runtime, runtime.storage('session'));
    const job = await store.createJob('orphan', 'attached', { pid: 42424242, promotedAt: Date.now() });
    const shell = vi.spyOn(runtime, 'shell').mockRejectedValue(new Error('Unexpected PID probe or signal'));
    await expect(manager.stop(job.meta.id)).resolves.toMatchObject({ status: { status: 'unknown', error: orphanError } });
    expect(shell).not.toHaveBeenCalled();
  });

  it('rejects input to a promoted non-PTY child', async () => {
    const { runtime, manager } = await createFixture();
    const process = await startProcess(runtime, 'sleep 30');
    const write = vi.spyOn(process, 'write');
    const job = await manager.promote('sleep 30', process, Date.now());
    await expect(manager.writeInteractive(job.meta.id, 'hello\n')).rejects.toThrow(
      'Process stdin is unavailable; start the command with tty: true for interactive input.',
    );
    expect(write).not.toHaveBeenCalled();
  });

  it.each([1, 2])('records failed promotion without terminating the child when output write %i fails', async (failAt) => {
    const { runtime } = await createFixture();
    const storage = runtime.storage('session');
    let writes = 0;
    vi.spyOn(runtime, 'storage').mockReturnValue({
      ...storage,
      async writeFile(path, content) {
        if (path.endsWith('output.log') && ++writes === failAt) throw new Error('output write failed');
        await storage.writeFile(path, content);
      },
      async appendFile(path, content) {
        if (path.endsWith('output.log') && ++writes === failAt) throw new Error('output write failed');
        await storage.appendFile(path, content);
      },
    });
    const manager = createManager(runtime);
    const process = await startProcess(runtime, 'sleep 30');
    const terminate = vi.spyOn(process, 'terminate');
    const dispose = vi.spyOn(process, 'dispose');
    await expect(manager.promote('sleep 30', process, Date.now())).rejects.toThrow('output write failed');
    await manager.shutdownInteractive();

    expect(terminate).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect((await process.read(0)).running).toBe(true);
    const jobs = await manager.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toMatchObject({ status: 'failed', error: 'output write failed' });
  });
});

function createManager(runtime: HostAgentRuntime): BackgroundBashManager {
  const manager = new BackgroundBashManager(runtime);
  managers.push(manager);
  return manager;
}

async function createFixture(): Promise<{ runtime: HostAgentRuntime; manager: BackgroundBashManager }> {
  const root = await mkdtemp(join(tmpdir(), 'felan attached jobs-'));
  roots.push(root);
  const cwd = join(root, 'workspace');
  const sessionStorageRoot = join(root, 'session-storage');
  const agentStorageRoot = join(root, 'agent-storage');
  await Promise.all([cwd, sessionStorageRoot, agentStorageRoot].map((path) => mkdir(path, { recursive: true })));
  const runtime = new HostAgentRuntime(cwd, { sessionStorageRoot, agentStorageRoot });
  return { runtime, manager: createManager(runtime) };
}

async function startProcess(runtime: HostAgentRuntime, command: string): Promise<AgentRuntimeProcess> {
  const process = await runtime.processes!.startShell(command, { cwd: runtime.cwd, shellFlavor: 'posix', login: false });
  processes.push(process);
  return process;
}
