import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostAgentRuntime } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it } from 'vitest';
import { getBackgroundBashJobsDir } from '../src/job-store.js';
import { BackgroundBashManager } from '../src/process-manager.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
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
    const { manager, runtime } = await createManager();
    const started = await manager.start("printf 'first\\nsecond\\n'");

    const result = await manager.wait(started.meta.id, 10);

    expect(result.timedOut).toBe(false);
    expect(result.job.status).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(started.meta.logPath).toContain(join(runtime.storage.root, 'background-bash'));
    expect(started.meta.logPath).not.toContain(`${join('.pi', 'background-bash')}`);
    await expect(runtime.readFile(started.meta.logPath)).rejects.toThrow('escapes runtime root');
    await expect(manager.tail(started.meta.id)).resolves.toContain('first\nsecond');
    await expect(manager.list('completed')).resolves.toHaveLength(1);
  });

  it('stops a running process and rejects ids outside the process registry', async () => {
    const { manager, runtime } = await createManager();
    const started = await manager.start("sleep 30 & echo $! > child.pid; wait");
    const childPid = await readPid(runtime, 'child.pid');

    const stopped = await manager.stop(started.meta.id, 'SIGTERM');

    expect(stopped.status).toMatchObject({ status: 'killed', signal: 'SIGTERM' });
    await expect(waitForProcessExit(runtime, childPid)).resolves.toBeUndefined();
    await expect(manager.get('../../outside')).rejects.toThrow(
      'Background Bash process not found: ../../outside',
    );
  });
});

async function createManager(): Promise<{
  manager: BackgroundBashManager;
  runtime: HostAgentRuntime;
}> {
  const root = await mkdtemp(join(tmpdir(), 'felan-background-bash-'));
  temporaryPaths.push(root);
  const cwd = join(root, 'workspace');
  const storageRoot = join(root, 'felan-state');
  await Promise.all([cwd, storageRoot].map((path) => mkdir(path, { recursive: true })));
  const runtime = new HostAgentRuntime(cwd, { storageRoot });
  return { manager: new BackgroundBashManager(runtime), runtime };
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
    const result = await runtime.exec(
      'ps',
      ['-o', 'stat=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'command=', '-p', String(pid)],
    );
    processInfo = result.stdout.trim();
    const state = processInfo.match(/^(\S+)/u)?.[1] ?? '';
    if (result.code !== 0 || state === '' || state.startsWith('Z')) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Descendant process ${pid} is still running: ${processInfo}`);
}
