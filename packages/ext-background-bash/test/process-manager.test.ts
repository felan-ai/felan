import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostAgentRuntime, type AgentRuntime, type AgentRuntimeProcess, type AgentRuntimeStorageScope } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundBashCoordinator } from '../src/coordinator.js';
import { BackgroundBashJobStore, getBackgroundBashJobsDir } from '../src/job-store.js';
import { BackgroundBashManager } from '../src/process-manager.js';

const temporaryPaths: string[] = [];
const startedJobs: Array<{ manager: BackgroundBashManager; id: string }> = [];
const INTEGRATION_TEST_TIMEOUT_MS = 30_000;
const INTEGRATION_WAIT_TIMEOUT_SECONDS = 20;

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

  it('preserves detached completion after foreground promotion', async () => {
    const { manager, runtime } = await createManager();
    const started = await manager.start("sleep 1; exit 7");
    trackJob(manager, started.meta.id);

    await manager.markPromoted(started.meta.id);
    await expect(runtime.readFile(started.meta.completionPath)).rejects.toThrow();
    const result = await manager.wait(started.meta.id, INTEGRATION_WAIT_TIMEOUT_SECONDS);

    expect(result.job.status).toMatchObject({ status: 'failed', exitCode: 7 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

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
    const { runtime } = await createManager();
    const coordinator = new BackgroundBashCoordinator(runtime);
    const first = new BackgroundBashManager(runtime, coordinator);
    const second = new BackgroundBashManager(runtime, coordinator);
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
    await coordinator.shutdown();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('keeps an in-flight PTY launch authoritative after five seconds without blocking list', async () => {
    const { runtime } = await createManager();
    const coordinator = new BackgroundBashCoordinator(runtime);
    const manager = new BackgroundBashManager(runtime, coordinator);
    const child = new BackgroundBashManager(runtime, coordinator);
    const store = new BackgroundBashJobStore(runtime, runtime.storage('session'));
    const startShell = runtime.terminals.startShell.bind(runtime.terminals);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(runtime.terminals, 'startShell').mockImplementation(async (command, options) => {
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
      await coordinator.shutdown();
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
    const startShell = runtime.terminals.startShell.bind(runtime.terminals);
    vi.spyOn(runtime.terminals, 'startShell').mockImplementation(async (command, options) => {
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
    const startShell = vi.spyOn(runtime.terminals, 'startShell');
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
    const coordinator = new BackgroundBashCoordinator(runtime);
    const manager = new BackgroundBashManager(runtime, coordinator);
    const child = new BackgroundBashManager(runtime, coordinator);
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
      if (launched.meta.pid) {
        await runtime.shell(`kill -KILL -${launched.meta.pid} 2>/dev/null || true`, { shellFlavor: 'posix' });
      }
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('does not publish a terminal outcome while a stopped detached runner is still exiting', async () => {
    const { manager, runtime } = await createManager();
    const job = await manager.start('trap \'trap "" TERM; sleep 7; exit 0\' TERM; printf ready; while :; do sleep 0.1; done');
    trackJob(manager, job.meta.id);
    for (let attempt = 0; !(await manager.tail(job.meta.id)).includes('ready'); attempt += 1) {
      if (attempt >= 40) throw new Error('Runner did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    try {
      await expect(manager.stop(job.meta.id, 'SIGTERM')).rejects.toThrow('did not exit after 5 seconds');
      expect((await manager.get(job.meta.id)).status.status).toBe('running');
      const finished = await manager.wait(job.meta.id, 5);
      expect(finished.job.status).toMatchObject({ status: 'killed', signal: 'SIGTERM' });
      expect((await manager.get(job.meta.id)).status).toEqual(finished.job.status);
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

async function createManager(): Promise<{
  manager: BackgroundBashManager;
  runtime: HostAgentRuntime;
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
    storage(scope = 'session') {
      storageScopes.push(scope);
      return runtime.storage(scope);
    },
    exec: runtime.exec.bind(runtime),
    shell: runtime.shell.bind(runtime),
    readFile: runtime.readFile.bind(runtime),
    writeFile: runtime.writeFile.bind(runtime),
    listFiles: runtime.listFiles.bind(runtime),
    mkdir: runtime.mkdir.bind(runtime),
    remove: runtime.remove.bind(runtime),
  };
  return { manager: new BackgroundBashManager(observedRuntime), runtime, storageScopes };
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
    const result = await runtime.shell(`kill -0 -- ${String(pid)} 2>/dev/null`, {
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
