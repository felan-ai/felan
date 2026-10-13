import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HostAgentRuntime, type AgentRuntime } from '@felan-ai/agent-core';
import { BackgroundBashManager } from '@felan-ai/ext-background-bash';
import { createLocalProcessAdapter } from '../../src/providers/process-adapter.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('describes background job storage as a neutral process record', async () => {
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
  const bytes = await runtime.storage().readFile(job.meta.infoPath);
  expect(adapter.describeJob(runtime, job.meta.infoPath, bytes)).toEqual({
    id: job.meta.id, kind: 'detached', status: 'running', command: 'synthetic detached',
    startedAt: job.meta.startedAt, startIdentity: job.meta.processToken,
    outputPath: job.meta.logPath, commandIdentity: [job.meta.runnerPath, job.meta.processToken],
  });
  expect(adapter.describeJob(runtime, job.meta.logPath, bytes)).toBeUndefined();
  for (const change of [{ id: 'invalid' }, { infoPath: '/other/info.json' }, { jobDir: '/other' }, { logPath: '/other/output.log' }]) {
    const altered = new TextEncoder().encode(JSON.stringify({ ...job.info, ...change }));
    expect(() => adapter.describeJob(runtime, job.meta.infoPath, altered)).toThrow('identity');
  }
  expect(() => adapter.describeJob(runtime, job.meta.infoPath, new TextEncoder().encode('{'))).toThrow('record');
});
