import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostAgentRuntime, type AgentRuntime, type AgentRuntimeStorageScope } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it } from 'vitest';
import { getBackgroundBashJobsDir } from '../src/job-store.js';
import { BackgroundBashManager } from '../src/process-manager.js';

const temporaryPaths: string[] = [];
const startedJobs: Array<{ manager: BackgroundBashManager; id: string }> = [];
const INTEGRATION_TEST_TIMEOUT_MS = 30_000;
const INTEGRATION_WAIT_TIMEOUT_SECONDS = 20;

afterEach(async () => {
  await Promise.all(startedJobs.splice(0).map(async ({ manager, id }) => {
    try {
      await manager.stop(id, 'SIGKILL');
    } catch {}
  }));
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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

  it('stops a running process and rejects ids outside the process registry', async () => {
    const { manager, runtime } = await createManager();
    const started = await manager.start("sleep 30 & echo $! > child.pid; wait");
    trackJob(manager, started.meta.id);
    const childPid = await readPid(runtime, 'child.pid');

    const stopped = await manager.stop(started.meta.id, 'SIGTERM');

    expect(stopped.status).toMatchObject({ status: 'killed', signal: 'SIGTERM' });
    await expect(waitForProcessExit(runtime, childPid)).resolves.toBeUndefined();
    await expect(manager.get('../../outside')).rejects.toThrow(
      'Background Bash process not found: ../../outside',
    );
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('stops a process immediately after launch without losing runner identity', async () => {
    const { manager } = await createManager();
    const started = await manager.start('sleep 30');
    trackJob(manager, started.meta.id);

    const stopped = await manager.stop(started.meta.id, 'SIGTERM');

    expect(stopped.status).toMatchObject({ status: 'killed', signal: 'SIGTERM' });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('does not replace natural completion with an unknown stop result', async () => {
    const { manager } = await createManager();
    const started = await manager.start('printf done');
    trackJob(manager, started.meta.id);

    await expect(manager.wait(started.meta.id, INTEGRATION_WAIT_TIMEOUT_SECONDS)).resolves.toMatchObject({
      timedOut: false,
      job: { status: { status: 'completed', exitCode: 0 } },
    });
    const stopped = await manager.stop(started.meta.id, 'SIGTERM');

    expect(stopped.status).toMatchObject({ status: 'completed', exitCode: 0 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

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
