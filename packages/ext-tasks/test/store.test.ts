import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostAgentRuntime, type AgentRuntime, type AgentRuntimeStorage } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskStore } from '../src/store.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('TaskStore', () => {
  it('persists state and restores it through another runtime instance', async () => {
    const harness = await runtimeHarness();
    const first = new TaskStore(harness.runtime());
    const created = await first.create({ title: 'Persist me' });
    first.close();

    const second = new TaskStore(harness.runtime());
    await expect(second.get(created.task.id)).resolves.toMatchObject({
      task: { id: created.task.id, title: 'Persist me', status: 'pending' },
      state: { revision: 1 },
    });
    second.close();
  });

  it('serializes claims across stores sharing one root session', async () => {
    const harness = await runtimeHarness();
    const first = new TaskStore(harness.runtime());
    const second = new TaskStore(harness.runtime());
    const created = await first.create({ title: 'Claim once' });

    const claims = await Promise.allSettled([
      first.update({ taskId: created.task.id, status: 'in_progress' }, 'worker-a'),
      second.update({ taskId: created.task.id, status: 'in_progress' }, 'worker-b'),
    ]);
    expect(claims.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(claims.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await first.get(created.task.id)).task).toMatchObject({ status: 'in_progress' });
    first.close();
    second.close();
  });

  it('uses each runtime instance storage adapter', async () => {
    const harness = await runtimeHarness();
    const firstRuntime = instrumentRuntime(harness.runtime());
    const secondRuntime = instrumentRuntime(harness.runtime());
    const first = new TaskStore(firstRuntime.runtime);
    const second = new TaskStore(secondRuntime.runtime);

    await first.create({ title: 'First adapter' });
    await second.create({ title: 'Second adapter' });

    expect(firstRuntime.writeFile).toHaveBeenCalledTimes(1);
    expect(secondRuntime.writeFile).toHaveBeenCalledTimes(1);
    first.close();
    second.close();
  });

  it('publishes mutations to every extension instance using the shared store', async () => {
    const harness = await runtimeHarness();
    const first = new TaskStore(harness.runtime());
    const second = new TaskStore(harness.runtime());
    const revisions: number[] = [];
    const unsubscribe = second.subscribe((state) => revisions.push(state.revision));

    await first.create({ title: 'Shared update' });

    expect(revisions).toContain(1);
    unsubscribe();
    first.close();
    second.close();
  });

  it('does not report a persisted mutation as failed when a listener throws', async () => {
    const harness = await runtimeHarness();
    const store = new TaskStore(harness.runtime());
    store.subscribe(() => {
      throw new Error('presentation failed');
    });

    const result = await store.create({ title: 'Persist despite listener' });

    await expect(store.get(result.task.id)).resolves.toMatchObject({
      task: { title: 'Persist despite listener' },
      state: { revision: 1 },
    });
    store.close();
  });

  it('removes its listeners when closed', async () => {
    const harness = await runtimeHarness();
    const first = new TaskStore(harness.runtime());
    const second = new TaskStore(harness.runtime());
    let notifications = 0;
    first.subscribe(() => {
      notifications += 1;
    });

    first.close();
    await second.create({ title: 'No stale notification' });

    expect(notifications).toBe(0);
    second.close();
  });
});

async function runtimeHarness() {
  const root = await mkdtemp(join(tmpdir(), 'felan-tasks-'));
  temporaryPaths.push(root);
  const cwd = join(root, 'workspace');
  const sessionStorageRoot = join(root, 'session');
  const agentStorageRoot = join(root, 'agent');
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(sessionStorageRoot, { recursive: true }),
    mkdir(agentStorageRoot, { recursive: true }),
  ]);
  return {
    runtime: () => new HostAgentRuntime(cwd, { sessionStorageRoot, agentStorageRoot }),
  };
}

function instrumentRuntime(runtime: HostAgentRuntime) {
  const source = runtime.storage('session');
  const writeFile = vi.fn(source.writeFile.bind(source));
  const storage = {
    root: source.root,
    readFile: source.readFile.bind(source),
    writeFile,
    listFiles: source.listFiles.bind(source),
    mkdir: source.mkdir.bind(source),
    remove: source.remove.bind(source),
  } satisfies AgentRuntimeStorage;
  return {
    runtime: new Proxy(runtime, {
      get: (target, property, receiver) => (
        property === 'storage' ? () => storage : Reflect.get(target, property, receiver)
      ),
    }) as AgentRuntime,
    writeFile,
  };
}
