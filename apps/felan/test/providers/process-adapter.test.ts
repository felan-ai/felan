import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HostAgentRuntime, type AgentRuntime } from '@felan-ai/agent-core';
import { BackgroundBashManager } from '@felan-ai/ext-background-bash';
import { createLocalProcessAdapter } from '../../src/providers/process-adapter.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it.each(['detached', 'pty', 'attached'] as const)('handles %s background job records', async executionMode => {
  const directory = await mkdtemp(join(tmpdir(), 'felan-process-adapter-')); temporary.push(directory);
  await mkdir(join(directory, 'session'));
  await mkdir(join(directory, 'agent'));
  const host = new HostAgentRuntime(directory, { sessionStorageRoot: join(directory, 'session'), agentStorageRoot: join(directory, 'agent') });
  const runtime = new Proxy(host, { get(target, key) {
    if (key === 'shell') return async () => ({ stdout: 'group:4242:4242\n', stderr: '', code: 0, killed: false });
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as AgentRuntime;
  const job = await new BackgroundBashManager(runtime).start('synthetic detached');
  const adapter = createLocalProcessAdapter();
  const bytes = new TextEncoder().encode(JSON.stringify({ ...job.info, executionMode }));
  const record = adapter.describeJob(runtime, job.meta.infoPath, bytes);
  if (executionMode === 'attached') expect(record).toBeUndefined();
  else expect(record).toEqual({
    id: job.meta.id, kind: executionMode, status: 'running', command: 'synthetic detached',
    startedAt: job.meta.startedAt, startIdentity: job.meta.processToken,
    outputPath: job.meta.logPath, commandIdentity: [job.meta.runnerPath, job.meta.processToken],
  });
  expect(adapter.describeJob(runtime, job.meta.logPath, bytes)).toBeUndefined();
  for (const change of [{ id: 'invalid' }, { infoPath: '/other/info.json' }, { jobDir: '/other' }, { logPath: '/other/output.log' }]) {
    const altered = new TextEncoder().encode(JSON.stringify({ ...job.info, executionMode, ...change }));
    expect(() => adapter.describeJob(runtime, job.meta.infoPath, altered)).toThrow('identity');
  }
  expect(() => adapter.describeJob(runtime, job.meta.infoPath, new TextEncoder().encode('{'))).toThrow('record');
});

it('hides a foreground job until promotion and reports a pending finish notice and a verified runner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'felan-process-adapter-')); temporary.push(directory);
  await mkdir(join(directory, 'session'));
  await mkdir(join(directory, 'agent'));
  // The foreground start writes its record from the launch shell call, so this test runs a real job.
  const runtime = new HostAgentRuntime(directory, { sessionStorageRoot: join(directory, 'session'), agentStorageRoot: join(directory, 'agent') });
  const manager = new BackgroundBashManager(runtime);
  const job = await manager.startForeground('sleep 30', 'session-a');
  try {
    const adapter = createLocalProcessAdapter();
    const describe = async () => adapter.describeJob(runtime, job.meta.infoPath, await runtime.storage('session').readFile(job.meta.infoPath));
    expect(await describe()).toBeUndefined();
    await manager.markPromoted(job.meta.id);
    expect(await describe()).toMatchObject({ id: job.meta.id, kind: 'detached', status: 'running', notice: 'pending' });
    expect(await manager.settleNotice(job.meta.id, 'session-a')).toBe(true);
    expect(await describe()).not.toHaveProperty('notice');
    // The daemon of a Windows host relies on this identity check, because it cannot inspect a Git Bash PID itself.
    await vi.waitFor(async () => expect(await adapter.inspectDetached(runtime, job.meta.id))
      .toEqual({ status: 'running', pid: job.meta.pid, verified: true }), { timeout: 10_000 });
    await manager.stop(job.meta.id, 'SIGKILL');
    expect(await adapter.inspectDetached(runtime, job.meta.id)).toMatchObject({ status: 'killed', verified: false });
  } finally {
    await manager.stop(job.meta.id, 'SIGKILL');
  }
});
