import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostAgentRuntime, type AgentRuntime, type AgentRuntimeProcess, type AgentRuntimeStorageScope } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withOwnedTerminals } from './owned-terminals.js';
import { BackgroundBashJobStore, getBackgroundBashJobsDir } from '../src/job-store.js';
import { BackgroundBashManager } from '../src/process-manager.js';

const temporaryPaths: string[] = [];
const startedJobs: Array<{ manager: BackgroundBashManager; id: string }> = [];
const INTEGRATION_TEST_TIMEOUT_MS = 30_000;
const INTEGRATION_WAIT_TIMEOUT_SECONDS = 20;
const SIGNAL_TEST_SHELLS = [
  { label: 'default shell', executable: undefined },
  ...(existsSync('/bin/dash') ? [{ label: 'dash', executable: '/bin/dash' }] : []),
];

afterEach(async () => {
  vi.restoreAllMocks();
  const jobs = startedJobs.splice(0);
  const stops = await Promise.allSettled(jobs.map(({ manager, id }) => manager.stop(id, 'SIGKILL')));
  const shutdowns = await Promise.allSettled([...new Set(jobs.map(({ manager }) => manager))]
    .map((manager) => manager.shutdownInteractive()));
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  const failures = [...stops, ...shutdowns].filter((result) => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Process fixture cleanup failed');
});

describe('BackgroundBashManager', () => {
  it('uses a stable, isolated registry for each workspace', () => {
    const first = getBackgroundBashJobsDir('/felan-state', '/workspaces/first');
    const repeated = getBackgroundBashJobsDir('/felan-state', '/workspaces/first');
    const second = getBackgroundBashJobsDir('/felan-state', '/workspaces/second');

    expect(first).toBe(repeated);
    expect(first).not.toBe(second);
    expect(first).toContain(join('/felan-state', 'background-bash'));
  });

  it('starts, persists, waits for, and tails a detached process through runtime storage', async () => {
    const { manager, runtime, storageScopes } = await createManager();
    const started = await manager.start("printf 'first\\nsecond\\n'");
    trackJob(manager, started.meta.id);

    const result = await manager.wait(started.meta.id, INTEGRATION_WAIT_TIMEOUT_SECONDS);

    expect(result.timedOut).toBe(false);
    expect(result.job.status).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(started.meta.logPath).toContain(join(runtime.storage('session').root, 'background-bash'));
    expect(started.meta.logPath).not.toContain(`${join('.pi', 'background-bash')}`);
    await expect(runtime.readFile(started.meta.logPath)).resolves.toContain(102);
    await expect(runtime.readFile(started.meta.infoPath)).resolves.toContain(123);
    expect(storageScopes).toEqual(['session']);
    await expect(manager.tail(started.meta.id)).resolves.toContain('first\nsecond');
    await expect(manager.list('completed')).resolves.toHaveLength(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('lists running jobs first and sorts each group by most recent start', async () => {
    const { manager, runtime } = await createManager();
    const store = new BackgroundBashJobStore(runtime, runtime.storage('session'));
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValue(1_000);
    const olderRunning = await store.createJob('older running');
    now.mockReturnValue(2_000);
    const olderFinished = await store.createJob('older finished');
    await store.markStatus(olderFinished.meta.id, { status: 'completed', exitCode: 0 });
    now.mockReturnValue(3_000);
    const newerRunning = await store.createJob('newer running');
    now.mockReturnValue(4_000);
    const newerFinished = await store.createJob('newer finished');
    await store.markStatus(newerFinished.meta.id, { status: 'failed', exitCode: 1 });

    const listed = await manager.list('all');

    expect(listed.map((job) => job.meta.id)).toEqual([
      newerRunning.meta.id,
      olderRunning.meta.id,
      newerFinished.meta.id,
      olderFinished.meta.id,
    ]);
  });

  it('preserves detached completion after foreground promotion', async () => {
    const { manager, runtime } = await createManager();
    const started = await manager.start("sleep 1; exit 7");
    trackJob(manager, started.meta.id);

    await manager.markPromoted(started.meta.id);
    await expect(runtime.readFile(started.meta.completionPath)).rejects.toThrow();
    const result = await manager.wait(started.meta.id, INTEGRATION_WAIT_TIMEOUT_SECONDS);

    expect(result.job.status).toMatchObject({ status: 'failed', exitCode: 7 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('appends promoted output once per poll and releases completed ownership', async () => {
    const { runtime } = await createManager();
    const storage = runtime.storage('session');
    vi.spyOn(runtime, 'storage').mockReturnValue(storage);
    const write = vi.spyOn(storage, 'writeFile');
    const append = vi.spyOn(storage, 'appendFile');
    const manager = new BackgroundBashManager(runtime);
    const other = new BackgroundBashManager(runtime);
    let output = 'first';
    let running = true;
    const process = {
      pid: 1234,
      read: vi.fn(async (offset: number) => {
        const bytes = new TextEncoder().encode(output);
        return { output: bytes.slice(offset), nextOffset: bytes.length, running, ...(!running ? { exitCode: 7 } : {}) };
      }),
      write: vi.fn(async () => {}),
      terminate: vi.fn(async () => { running = false; }),
      dispose: vi.fn(async () => {}),
    } satisfies AgentRuntimeProcess;
    const job = await manager.promote('command', process, Date.now() - 1_000);
    trackJob(manager, job.meta.id);
    expect(job.meta).toMatchObject({ pid: 1234, processGroupId: 1234 });
    output += '\nsecond';
    await other.get(job.meta.id);
    await other.get(job.meta.id);
    output += '\nthird';
    running = false;
    const completed = await other.get(job.meta.id);

    expect(completed.status).toMatchObject({ status: 'failed', exitCode: 7 });
    expect(new TextDecoder().decode(await storage.readFile(job.meta.logPath))).toBe('first\nsecond\nthird');
    expect(write.mock.calls.filter(([path]) => path === job.meta.logPath)).toHaveLength(1);
    expect(append.mock.calls.filter(([path]) => path === job.meta.logPath)
      .map(([, content]) => new TextDecoder().decode(content))).toEqual(['first', '\nsecond', '\nthird']);
    expect(process.dispose).toHaveBeenCalledOnce();
    await expect(manager.readInteractive(job.meta.id)).rejects.toThrow('not found');

    const ownerGet = vi.spyOn(manager, 'get');
    const readCount = process.read.mock.calls.length;
    await expect(other.get(job.meta.id)).resolves.toEqual(completed);
    await expect(other.stop(job.meta.id)).resolves.toEqual(completed);
    await expect(manager.get(job.meta.id)).resolves.toEqual(completed);
    expect(ownerGet).toHaveBeenCalledTimes(1);
    expect(process.read).toHaveBeenCalledTimes(readCount);
  });

  it.each(['append', 'status'])('retries a failed terminal %s without losing or duplicating output', async (failure) => {
    const { runtime } = await createManager();
    const storage = runtime.storage('session');
    vi.spyOn(runtime, 'storage').mockReturnValue(storage);
    const manager = new BackgroundBashManager(runtime);
    let output = 'before';
    let running = true;
    const process = {
      pid: 1234,
      read: vi.fn(async (offset: number) => {
        const bytes = new TextEncoder().encode(output);
        return { output: bytes.slice(offset), nextOffset: bytes.length, running, ...(!running ? { exitCode: 0 } : {}) };
      }),
      write: vi.fn(async () => {}),
      terminate: vi.fn(async () => { running = false; }),
      dispose: vi.fn(async () => {}),
    } satisfies AgentRuntimeProcess;
    const job = await manager.promote('command', process, Date.now());
    trackJob(manager, job.meta.id);
    if (failure === 'append') {
      vi.spyOn(storage, 'appendFile').mockRejectedValueOnce(new Error('append failed'));
    } else {
      vi.spyOn(storage, 'writeFile').mockRejectedValueOnce(new Error('status failed'));
    }
    output += 'after';
    running = false;
    await expect(manager.get(job.meta.id)).rejects.toThrow(`${failure} failed`);
    expect(process.dispose).not.toHaveBeenCalled();
    await expect(manager.get(job.meta.id)).resolves.toMatchObject({ status: { status: 'completed', exitCode: 0 } });
    expect(new TextDecoder().decode(await storage.readFile(job.meta.logPath))).toBe('beforeafter');
    expect(process.read).toHaveBeenCalledTimes(2);
    expect(process.dispose).toHaveBeenCalledOnce();
  });

  it.each(['shutdownInteractive', 'shutdownAttached'] as const)('%s releases ownership even when stopping fails', async (shutdown) => {
    const { runtime } = await createManager();
    const manager = new BackgroundBashManager(runtime);
    const other = new BackgroundBashManager(runtime);
    const process = {
      pid: 1234,
      read: vi.fn(async () => ({ output: new Uint8Array(), nextOffset: 0, running: true })),
      write: vi.fn(async () => {}),
      terminate: vi.fn(async () => { throw new Error('stop failed'); }),
      dispose: vi.fn(async () => {}),
    } satisfies AgentRuntimeProcess;
    const job = await manager.promote('command', process, Date.now());
    await expect(manager[shutdown]()).rejects.toThrow('Failed to');
    expect(process.terminate).toHaveBeenCalledWith('SIGTERM');
    expect(process.dispose).toHaveBeenCalledOnce();
    vi.spyOn(Date, 'now').mockReturnValue(job.meta.promotedAt! + 6_000);
    const ownerGet = vi.spyOn(manager, 'get');
    const readCount = process.read.mock.calls.length;

    await expect(other.get(job.meta.id)).resolves.toMatchObject({
      status: { status: 'unknown', error: 'Process is not attached to a live root session; its exit status is unavailable.' },
    });
    expect(ownerGet).not.toHaveBeenCalled();
    expect(process.read).toHaveBeenCalledTimes(readCount);
  });

  it('stops a running process and rejects ids outside the process registry', async () => {
    const { manager, runtime } = await createManager();
    const started = await manager.start("sleep 30 & echo $! > child.pid; wait");
    trackJob(manager, started.meta.id);
    const childPid = await readPid(runtime, 'child.pid');

    const stopped = await manager.stop(started.meta.id, 'SIGTERM');

    expect(stopped.status).toMatchObject({ status: 'killed', signal: 'SIGTERM' });
    await expect(waitForProcessExit(runtime, childPid)).resolves.toBeUndefined();
    await expect(manager.get('../../outside')).rejects.toThrow(
      'Background process not found: ../../outside',
    );
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('stops a process immediately after launch without losing runner identity', async () => {
    const { manager } = await createManager();
    const started = await manager.start('sleep 30');
    trackJob(manager, started.meta.id);

    const stopped = await manager.stop(started.meta.id, 'SIGTERM');

    expect(stopped.status).toMatchObject({ status: 'killed', signal: 'SIGTERM' });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('keeps shared live PTYs running after the detached process identity grace period', async () => {
    const { runtime: source } = await createManager();
    const { runtime, shutdown } = withOwnedTerminals(source);
    const first = new BackgroundBashManager(runtime);
    const second = new BackgroundBashManager(runtime);
    const started = await first.startInteractive('read input; printf "result:%s\\n" "$input"; exit 7');
    trackJob(first, started.job.meta.id);
    vi.spyOn(Date, 'now').mockReturnValue(started.job.meta.startedAt + 6_000);

    const listed = await second.list('running');

    expect(listed.map((job) => job.meta.id)).toContain(started.job.meta.id);
    await expect(first.wait(started.job.meta.id, 0)).resolves.toMatchObject({ timedOut: true });
    await expect(runtime.readFile(started.job.meta.completionPath)).rejects.toThrow();
    vi.restoreAllMocks();
    await second.writeInteractive(started.job.meta.id, 'hello\n');
    const completed = await first.wait(started.job.meta.id, 5);
    expect(completed.job.status).toMatchObject({ status: 'failed', exitCode: 7 });
    await expect(second.tail(started.job.meta.id)).resolves.toContain('result:hello');
    await shutdown();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('keeps an in-flight PTY launch authoritative after five seconds without blocking list', async () => {
    const { runtime: source } = await createManager();
    const { runtime, shutdown } = withOwnedTerminals(source);
    const manager = new BackgroundBashManager(runtime);
    const child = new BackgroundBashManager(runtime);
    const store = new BackgroundBashJobStore(runtime, runtime.storage('session'));
    const startShell = runtime.terminals!.startShell.bind(runtime.terminals);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(runtime.terminals!, 'startShell').mockImplementation(async (command, options) => {
      entered();
      await gate;
      return startShell(command, options);
    });
    const starting = manager.startInteractive('sleep 30');
    await entering;
    const [job] = await store.listJobs();
    vi.spyOn(Date, 'now').mockReturnValue(job!.meta.startedAt + 6_000);
    try {
      const listed = await child.list('running');
      expect(listed.map((item) => item.meta.id)).toContain(job!.meta.id);
    } finally {
      vi.restoreAllMocks();
      release();
      const started = await starting;
      trackJob(manager, started.job.meta.id);
      await shutdown();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it.each(['pty', 'detached', 'detached with terminalized metadata'] as const)('cleans up a launched %s when PID persistence fails', async (mode) => {
    const { runtime } = await createManager();
    const storage = runtime.storage('session');
    let failed = false;
    vi.spyOn(runtime, 'storage').mockReturnValue({
      ...storage,
      async writeFile(path, bytes) {
        if (path.endsWith('info.json') && !failed && JSON.parse(new TextDecoder().decode(bytes)).pid) {
          failed = true;
          if (mode === 'detached with terminalized metadata') {
            const info = JSON.parse(new TextDecoder().decode(bytes));
            await storage.writeFile(path, new TextEncoder().encode(JSON.stringify({ ...info, status: 'unknown' })));
          }
          throw new Error('metadata write failed');
        }
        await storage.writeFile(path, bytes);
      },
    });
    let processHandle: AgentRuntimeProcess | undefined;
    let runnerPid: number | undefined;
    const startShell = runtime.terminals!.startShell.bind(runtime.terminals);
    vi.spyOn(runtime.terminals!, 'startShell').mockImplementation(async (command, options) => {
      processHandle = await startShell(command, options);
      return processHandle;
    });
    const shell = runtime.shell.bind(runtime);
    vi.spyOn(runtime, 'shell').mockImplementation(async (command, options) => {
      const result = await shell(command, options);
      const launched = result.stdout.match(/^group:(\d+):\d+$/mu);
      if (launched) runnerPid = Number(launched[1]);
      return result;
    });
    const manager = new BackgroundBashManager(runtime);
    try {
      await expect(mode === 'pty' ? manager.startInteractive('sleep 30') : manager.start('sleep 30'))
        .rejects.toThrow('metadata write failed');
      expect(failed).toBe(true);
      if (mode === 'pty') {
        expect((await processHandle!.read(0)).running).toBe(false);
      } else {
        expect(runnerPid).toEqual(expect.any(Number));
        await waitForProcessExit(runtime, runnerPid!);
      }
    } finally {
      if (processHandle) { await processHandle.terminate('SIGKILL'); await processHandle.dispose(); }
      if (runnerPid) await shell(`kill -KILL -${runnerPid} 2>/dev/null || true`, { shellFlavor: 'posix' });
      await manager.shutdownInteractive();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it.each([
    { mode: 'pty', file: 'output.log' },
    { mode: 'pty', file: 'command.sh' },
    { mode: 'detached', file: 'output.log' },
    { mode: 'detached', file: 'command.sh' },
    { mode: 'detached', file: 'runner.sh' },
  ])('records a failed $mode startup when $file cannot be written', async ({ mode, file }) => {
    const { runtime } = await createManager();
    const storage = runtime.storage('session');
    vi.spyOn(runtime, 'storage').mockReturnValue({
      ...storage,
      async writeFile(path, content) {
        if (path.endsWith(file)) throw new Error('pre-launch write failed');
        await storage.writeFile(path, content);
      },
    });
    const manager = new BackgroundBashManager(runtime);
    const startShell = vi.spyOn(runtime.terminals!, 'startShell');
    const shell = vi.spyOn(runtime, 'shell');
    await expect(mode === 'pty' ? manager.startInteractive('unused') : manager.start('unused'))
      .rejects.toThrow('pre-launch write failed');
    const jobs = await new BackgroundBashJobStore(runtime, storage).listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toMatchObject({ status: 'failed', error: 'pre-launch write failed' });
    expect(startShell).not.toHaveBeenCalled();
    expect(shell).not.toHaveBeenCalled();
  });

  it.each(['pty', 'detached'])('keeps a slow pre-launch %s preparation running and stoppable', async (mode) => {
    const { runtime } = await createManager();
    const storage = runtime.storage('session');
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(runtime, 'storage').mockReturnValue({
      ...storage,
      async writeFile(path, content) {
        if (path.endsWith('command.sh')) { entered(); await gate; }
        await storage.writeFile(path, content);
      },
    });
    const owned = withOwnedTerminals(runtime);
    const manager = new BackgroundBashManager(owned.runtime);
    const child = new BackgroundBashManager(owned.runtime);
    const starting = mode === 'pty'
      ? manager.startInteractive('sleep 30').then((result) => result.job)
      : manager.start('sleep 30');
    await entering;
    const [job] = await new BackgroundBashJobStore(runtime, storage).listJobs();
    vi.spyOn(Date, 'now').mockReturnValue(job!.meta.startedAt + 6_000);
    try {
      expect((await child.list('running')).map((item) => item.meta.id)).toContain(job!.meta.id);
      const stopping = child.stop(job!.meta.id, 'SIGKILL');
      vi.restoreAllMocks();
      release();
      await starting;
      expect((await stopping).status.status).toBe('killed');
    } finally {
      vi.restoreAllMocks();
      release();
      const launched = await starting;
      trackJob(manager, launched.meta.id);
      await owned.shutdown();
      if (launched.meta.pid) {
        await runtime.shell(`kill -KILL -${launched.meta.pid} 2>/dev/null || true`, { shellFlavor: 'posix' });
      }
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('does not publish a terminal outcome while a stopped detached runner is still exiting', async () => {
    const { manager, runtime, observedRuntime } = await createManager();
    const store = new BackgroundBashJobStore(runtime, runtime.storage('session'));
    const job = await store.createJob('command', 'detached', { pid: 424242, processGroupId: 424242 });
    let signaled = false;
    let clock = job.meta.startedAt;
    vi.spyOn(Date, 'now').mockImplementation(() => signaled ? clock += 6_000 : clock);
    vi.spyOn(observedRuntime, 'shell').mockImplementation(async command => {
      if (command.startsWith('ps -o pgid=')) {
        return { code: 0, stdout: `424242 sh ${job.meta.runnerPath} ${job.meta.processToken}`, stderr: '', killed: false };
      }
      if (command === 'kill -TERM -424242') signaled = true;
      else if (command !== "kill -0 '424242' 2>/dev/null") throw new Error(`Unexpected process command: ${command}`);
      return { code: 0, stdout: '', stderr: '', killed: false };
    });

    await expect(manager.stop(job.meta.id, 'SIGTERM')).rejects.toThrow('did not exit after 5 seconds');
    expect(signaled).toBe(true);
    expect((await manager.get(job.meta.id)).status.status).toBe('running');
    await expect(runtime.readFile(job.meta.completionPath)).rejects.toThrow();
    await store.markStatus(job.meta.id, { status: 'killed', signal: 'SIGTERM' });
    const finished = await manager.wait(job.meta.id, 0);
    expect(finished.job.status).toMatchObject({ status: 'killed', signal: 'SIGTERM' });
    expect((await manager.get(job.meta.id)).status).toEqual(finished.job.status);
  });

  it.each(SIGNAL_TEST_SHELLS)('falls back to a positive PID signal when group signaling fails ($label)', async ({ executable }) => {
    const { manager, runtime, observedRuntime } = await createManager(executable);
    const job = await manager.start('exec sleep 30');
    trackJob(manager, job.meta.id);
    const shell = observedRuntime.shell.bind(observedRuntime);
    const probe = vi.spyOn(observedRuntime, 'shell').mockImplementation((command, options) => {
      if (command === `kill -TERM -${job.meta.pid}`) {
        return Promise.resolve({ code: 1, stdout: '', stderr: 'Group signaling unavailable', killed: false });
      }
      return shell(command, options);
    });
    try {
      const stopped = await manager.stop(job.meta.id, 'SIGTERM');
      expect(stopped.status).toMatchObject({ status: 'killed', signal: 'SIGTERM' });
      expect(probe).toHaveBeenCalledWith(`kill -TERM -${job.meta.pid}`, expect.anything());
      await waitForProcessExit(runtime, job.meta.pid!);
    } finally {
      await runtime.shell(`kill -KILL -${job.meta.pid} 2>/dev/null || true`, { shellFlavor: 'posix' });
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('does not inspect or signal an orphaned PTY PID', async () => {
    const { runtime } = await createManager();
    const store = new BackgroundBashJobStore(runtime, runtime.storage('session'));
    const job = await store.createJob('orphaned pty', 'pty');
    await store.updatePid(job.meta.id, 42424242);
    vi.spyOn(Date, 'now').mockReturnValue(job.meta.startedAt + 6_000);
    const shell = vi.spyOn(runtime, 'shell').mockRejectedValue(new Error('Unexpected PID inspection or signal'));
    const manager = new BackgroundBashManager(runtime);
    const orphan = await manager.stop(job.meta.id);
    expect(orphan.status).toMatchObject({ status: 'unknown', exitCode: null });
    expect(orphan.status.error).toContain('not attached to this root session');
    expect(shell).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'win32' || !nativeGitBashAvailable())(
    'runs and stops a detached process through native Git Bash process groups',
    async () => {
      const { manager } = await createManager();
      const started = await manager.start("printf 'windows git bash\\n'");
      trackJob(manager, started.meta.id);
      const completed = await manager.wait(started.meta.id, INTEGRATION_WAIT_TIMEOUT_SECONDS);

      expect(completed.job.status).toMatchObject({ status: 'completed', exitCode: 0 });
      await expect(manager.tail(started.meta.id)).resolves.toContain('windows git bash');

      const running = await manager.start('sleep 30');
      trackJob(manager, running.meta.id);
      await expect(manager.stop(running.meta.id)).resolves.toMatchObject({
        status: { status: 'killed', signal: 'SIGTERM' },
      });
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});

it('supports a PTY job with stdin and preserves its exit code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'felan-background-bash-pty-'));
  temporaryPaths.push(root);
  const cwd = join(root, 'workspace');
  const sessionStorageRoot = join(root, 'session-storage');
  const agentStorageRoot = join(root, 'agent-storage');
  await Promise.all([cwd, sessionStorageRoot, agentStorageRoot]
    .map((path) => mkdir(path, { recursive: true })));
  const runtime = new HostAgentRuntime(cwd, { sessionStorageRoot, agentStorageRoot });
  const manager = new BackgroundBashManager(runtime);
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('ready\\n'); process.stdin.once('data', value => { process.stdout.write('echo:' + value); process.exit(7) })")}`;
  const started = await manager.startInteractive(command);
  startedJobs.push({ manager, id: started.job.meta.id });
  const ready = await manager.readInteractive(started.job.meta.id, 1_000);
  expect(ready.output).toContain('ready');
  await manager.writeInteractive(started.job.meta.id, 'hello\n');
  let completed = await manager.readInteractive(started.job.meta.id, 1_000);
  for (let attempt = 0; completed.running && attempt < 5; attempt += 1) {
    completed = await manager.readInteractive(started.job.meta.id, 1_000);
  }
  expect(completed.output).toContain('echo:hello');
  expect(completed.running).toBe(false);
  expect(completed.exitCode).toBe(7);
  await expect(manager.get(started.job.meta.id)).resolves.toMatchObject({
    status: { status: 'failed', exitCode: 7 },
  });
  await manager.shutdownInteractive();
}, INTEGRATION_TEST_TIMEOUT_MS);

function trackJob(manager: BackgroundBashManager, id: string): void {
  startedJobs.push({ manager, id });
}

async function createManager(signalShell?: string): Promise<{
  manager: BackgroundBashManager;
  runtime: HostAgentRuntime;
  observedRuntime: AgentRuntime;
  storageScopes: AgentRuntimeStorageScope[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'felan background bash spaces-'));
  temporaryPaths.push(root);
  const cwd = join(root, 'workspace');
  const sessionStorageRoot = join(root, 'session-storage');
  const agentStorageRoot = join(root, 'agent-storage');
  await Promise.all([cwd, sessionStorageRoot, agentStorageRoot]
    .map((path) => mkdir(path, { recursive: true })));
  const runtime = new HostAgentRuntime(cwd, { sessionStorageRoot, agentStorageRoot });
  const storageScopes: AgentRuntimeStorageScope[] = [];
  const observedRuntime: AgentRuntime = {
    kind: runtime.kind,
    cwd: runtime.cwd,
    logger: runtime.logger,
    storage(scope = 'session') {
      storageScopes.push(scope);
      return runtime.storage(scope);
    },
    exec: runtime.exec.bind(runtime),
    shell: signalShell
      ? (command, options) => command.startsWith('kill ')
        ? runtime.exec(signalShell, ['-c', command], options)
        : runtime.shell(command, options)
      : runtime.shell.bind(runtime),
    readFile: runtime.readFile.bind(runtime),
    writeFile: runtime.writeFile.bind(runtime),
    listFiles: runtime.listFiles.bind(runtime),
    mkdir: runtime.mkdir.bind(runtime),
    remove: runtime.remove.bind(runtime),
  };
  return { manager: new BackgroundBashManager(observedRuntime), runtime, observedRuntime, storageScopes };
}

async function readPid(runtime: HostAgentRuntime, path: string): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const pid = Number(new TextDecoder().decode(await runtime.readFile(path)).trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Process id was not written to ${path}`);
}

async function waitForProcessExit(runtime: HostAgentRuntime, pid: number): Promise<void> {
  let processInfo = '';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await runtime.shell(`ps -p ${String(pid)}`, {
      shellFlavor: 'posix',
    });
    processInfo = result.stdout.trim();
    if (result.code !== 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Descendant process ${pid} is still running: ${processInfo}`);
}

function nativeGitBashAvailable(): boolean {
  const pathEntries = (process.env.Path ?? process.env.PATH ?? '').split(';').filter(Boolean);
  const roots = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
  ].filter((value): value is string => Boolean(value));
  const candidates = [
    process.env.FELAN_POSIX_SHELL,
    ...pathEntries.flatMap((entry) => [join(entry, 'bash.exe'), join(entry, 'sh.exe')]),
    ...roots.flatMap((root) => [
      join(root, 'Git', 'bin', 'bash.exe'),
      join(root, 'Git', 'bin', 'sh.exe'),
      join(root, 'Git', 'usr', 'bin', 'sh.exe'),
    ]),
  ];
  return candidates.some((candidate) => candidate !== undefined && existsSync(candidate));
}
