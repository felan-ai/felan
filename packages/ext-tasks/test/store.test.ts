import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostAgentRuntime } from '@felan-ai/agent-core';
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

  it('publishes full task records without undefined fields after successful mutations', async () => {
    const harness = await runtimeHarness();
    const changed = vi.fn();
    const source = harness.runtime();
    const runtime = new Proxy(source, { get: (target, property) => {
      if (property === 'tasks') return { changed };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const store = new TaskStore(runtime);
    await expect(store.snapshot()).resolves.toMatchObject({ revision: 0, tasks: [] });
    expect(changed).toHaveBeenNthCalledWith(1, []);
    const created = await store.create({
      title: 'Full task record',
      description: 'Publish all current task fields',
      acceptanceCriteria: 'The hook receives details and lifecycle metadata',
      priority: 0,
    });
    expect(changed.mock.calls[1]).toStrictEqual([[created.task]]);
    const claimed = await store.update({
      taskId: created.task.id,
      status: 'in_progress',
      notes: 'The task is ready for implementation',
    }, 'root');
    expect(changed.mock.calls[2]).toStrictEqual([[claimed.task]]);
    expect(claimed.task).toMatchObject({ ownerSessionId: 'root', claimedAt: expect.any(String) });

    const blocked = await store.update({
      taskId: created.task.id,
      status: 'blocked',
      blockedReason: 'Waiting for a dependency',
    }, 'root');
    expect(changed.mock.calls[3]).toStrictEqual([[blocked.task]]);
    await store.update({ taskId: created.task.id, status: 'pending' }, 'root');
    await store.update({ taskId: created.task.id, status: 'in_progress' }, 'root');
    const completed = await store.update({
      taskId: created.task.id,
      status: 'completed',
      result: 'All task fields reached the hook',
    }, 'root');
    expect(changed.mock.lastCall).toStrictEqual([[completed.task]]);
    expect(completed.task).toMatchObject({ completedAt: expect.any(String) });
    for (const [tasks] of changed.mock.calls) {
      for (const task of tasks) expect(Object.values(task)).not.toContain(undefined);
    }
    store.close();
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
