import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@felan-ai/agent-core';
import type {
  SubagentHost,
  SubagentCompletionNotice,
  SubagentParentPort,
  SubagentSpawnRequest,
} from '@felan-ai/ext-subagents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inspectionToolNames,
  LocalSubagentHost,
  type LocalSubagentRunner,
} from '../src/subagents/host.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('LocalSubagentHost', () => {
  it('keeps safe inspection tools and removes mutation and process tools', () => {
    expect(inspectionToolNames([
      'grep', 'find', 'ls', 'view_image', 'exec_command', 'write_stdin', 'apply_patch', 'enter_prewalk', 'mcp',
    ])).toEqual(['read', 'grep', 'find', 'ls', 'view_image', 'mcp']);
    expect(inspectionToolNames(['read', 'bash', 'edit', 'write', 'grep']))
      .toEqual(['read', 'grep']);
  });

  it('continues one child with the same agent ID, session file, and latest result', async () => {
    const sessionIds: string[] = [];
    const sessionFiles: Array<string | undefined> = [];
    const root = await temporaryDirectory();
    const retainedSession = join(root, 'child.jsonl');
    const runner: LocalSubagentRunner = async (input) => {
      sessionIds.push(input.sessionId);
      sessionFiles.push(input.sessionFile);
      await input.onReady({ steer: async () => {}, cancel: async () => {} });
      if (!input.sessionFile) await writeSessionHeader(retainedSession, root, input.sessionId);
      return { result: `done: ${input.initialMessage}`, sessionFile: retainedSession };
    };
    const { host } = await harness({ runner, root });
    host.attachParent(parentPort([]));

    const spawned = await host.spawn(request());
    expect(spawned).toMatchObject({ ok: true, value: { status: 'queued' } });
    if (!spawned.ok) return;
    await expect(waitForResult(host, spawned.value.agentId)).resolves.toMatchObject({
      ok: true,
      value: { status: 'completed', result: 'done: Review this' },
    });
    expect(sessionIds).toEqual([spawned.value.agentId]);

    const continued = await host.steer(spawned.value.agentId, 'continue');
    expect(continued).toMatchObject({ ok: true, value: { agentId: spawned.value.agentId } });
    const result = await waitForResult(host, spawned.value.agentId);
    expect(result).toMatchObject({
      ok: true,
      value: { status: 'completed', agentId: spawned.value.agentId, result: 'done: continue' },
    });
    expect(sessionFiles).toEqual([undefined, retainedSession]);
    await host.shutdown();
  });

  it('rejects unavailable or invalid retained Pi sessions before changing the latest record', async () => {
    const root = await temporaryDirectory();
    const retainedSession = join(root, 'retained.jsonl');
    let runs = 0;
    const { host } = await harness({
      root,
      runner: async (input) => {
        runs += 1;
        await input.onReady({ steer: async () => {}, cancel: async () => {} });
        await writeSessionHeader(retainedSession, root, input.sessionId);
        return { result: 'original result', sessionFile: retainedSession };
      },
    });
    const spawned = await host.spawn(request());
    if (!spawned.ok) return;
    await waitForResult(host, spawned.value.agentId);

    const validHeader = sessionHeader(root, spawned.value.agentId);
    for (const contents of [
      ' \n',
      `${validHeader}\n{"type":`,
      `${JSON.stringify({ value: 'valid JSON, not Pi' })}\n`,
      `${sessionHeader(root, 'another-child')}\n`,
    ]) {
      await writeFile(retainedSession, contents);
      await expect(host.steer(spawned.value.agentId, 'continue')).resolves.toMatchObject({
        ok: false,
        error: { code: 'not_steerable' },
      });
    }

    await rm(retainedSession);
    await mkdir(retainedSession);
    await expect(host.steer(spawned.value.agentId, 'continue')).resolves.toMatchObject({
      ok: false, error: { code: 'not_steerable' },
    });
    await rm(retainedSession, { recursive: true });
    await expect(host.steer(spawned.value.agentId, 'continue')).resolves.toMatchObject({
      ok: false, error: { code: 'not_steerable' },
    });
    await expect(host.getResult(spawned.value.agentId)).resolves.toMatchObject({
      ok: true,
      value: { status: 'completed', result: 'original result' },
    });
    expect(runs).toBe(1);
  });

  it('bounds asynchronous concurrency, queues work, and delivers completion once', async () => {
    const releases: Array<() => void> = [];
    const runner: LocalSubagentRunner = async (input) => {
      input.onReady({ steer: async () => {}, cancel: async () => {} });
      await new Promise<void>((resolve) => releases.push(resolve));
      return { result: input.initialMessage, sessionFile: `/retained/${input.sessionId}.jsonl` };
    };
    const { host } = await harness({ runner, concurrency: 1 });
    const notices: SubagentCompletionNotice[] = [];
    host.attachParent(parentPort(notices));

    const first = await host.spawn(request());
    const second = await host.spawn(request({ description: 'second' }));
    expect(first).toMatchObject({ ok: true, value: { status: 'queued' } });
    expect(second).toMatchObject({ ok: true, value: { status: 'queued' } });
    await settle();
    const listed = await host.list({ includeDescendants: false });
    expect(listed).toMatchObject({
      ok: true,
      value: [{ status: 'running' }, { status: 'queued' }],
    });

    releases.shift()!();
    if (!first.ok) return;
    await waitForResult(host, first.value.agentId);
    await settle();
    expect(notices).toHaveLength(1);
    await host.getResult(first.value.agentId);
    expect(notices).toHaveLength(1);
    releases.shift()!();
    if (second.ok) await waitForResult(host, second.value.agentId);
    await host.shutdown();
  });

  it('enforces direct-child controls and idempotent cascading cancellation', async () => {
    let childHost: SubagentHost | undefined;
    const runner: LocalSubagentRunner = async (input) => {
      childHost = input.subagents;
      input.onReady({ steer: async () => {}, cancel: async () => {} });
      await aborted(input.signal);
      return {};
    };
    const { host } = await harness({ runner });
    const spawned = await host.spawn(request());
    if (!spawned.ok) return;
    await settle();
    await expect(childHost!.getResult(spawned.value.agentId)).resolves.toMatchObject({
      ok: false, error: { code: 'not_child' },
    });
    const cancelled = await host.cancel(spawned.value.agentId, 'stop');
    const repeated = await host.cancel(spawned.value.agentId, 'stop again');
    expect(cancelled).toMatchObject({ ok: true, value: { status: 'cancelled' } });
    expect(repeated).toEqual(cancelled);
  });

  it('reconciles stale active records after an unclean restart', async () => {
    const root = await temporaryDirectory();
    const runner: LocalSubagentRunner = async (input) => {
      input.onReady({ steer: async () => {}, cancel: async () => {} });
      await new Promise(() => {});
      return {};
    };
    const first = await harness({ runner, root });
    const spawned = await first.host.spawn(request());
    await settle();
    const second = await harness({ runner, root });
    if (!spawned.ok) return;
    const notices: SubagentCompletionNotice[] = [];
    second.host.attachParent(parentPort(notices));

    await expect(second.host.getResult(spawned.value.agentId)).resolves.toMatchObject({
      ok: true,
      value: {
        status: 'cancelled',
        error: { code: 'host_unavailable' },
      },
    });
    await settle();
    expect(notices).toEqual([
      expect.objectContaining({
        agentId: spawned.value.agentId,
        status: 'cancelled',
      }),
    ]);
  });

  it('validates thinking against the exact model', async () => {
    const selected: Array<string | undefined> = [];
    const runner: LocalSubagentRunner = async (input) => {
      selected.push(input.request.model);
      input.onReady({ steer: async () => {}, cancel: async () => {} });
      return { result: 'done', sessionFile: `/retained/${input.sessionId}.jsonl` };
    };
    const models = [
      { provider: 'plain-provider', id: 'plain-model', reasoning: false },
      {
        provider: 'reasoning-provider',
        id: 'reasoning-model',
        reasoning: true,
        thinkingLevelMap: { xhigh: null, max: 'max' },
      },
    ];
    const modelRuntime = {
      getAvailableSnapshot: () => models,
      hasConfiguredAuth: () => true,
      getModel: (provider: string, id: string) => models.find((model) => (
        model.provider === provider && model.id === id
      )),
    } as unknown as ModelRuntime;
    const { host } = await harness({ runner, modelRuntime });

    const high = await host.spawn(request({
      model: 'reasoning-provider/reasoning-model',
      thinking: 'high',
    }));
    const max = await host.spawn(request({
      model: 'reasoning-provider/reasoning-model',
      thinking: 'max',
    }));
    if (high.ok) await waitForResult(host, high.value.agentId);
    if (max.ok) await waitForResult(host, max.value.agentId);

    expect(selected).toEqual([
      'reasoning-provider/reasoning-model',
      'reasoning-provider/reasoning-model',
    ]);
    await expect(host.spawn(request({ model: 'missing/model' }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported_model' },
    });
    await expect(host.spawn(request({
      model: 'plain-provider/plain-model',
      thinking: 'medium',
    }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported_thinking' },
    });
    await expect(host.spawn(request({
      model: 'reasoning-provider/reasoning-model',
      thinking: 'xhigh',
    }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported_thinking' },
    });
  });

  it('admits work asynchronously while all execution slots are occupied', async () => {
    let releaseFirst!: () => void;
    const runner: LocalSubagentRunner = async (input) => {
      input.onReady({ steer: async () => {}, cancel: async () => {} });
      if (input.request.description === 'first') {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return { result: 'done' };
    };
    const { host } = await harness({ runner, concurrency: 1 });

    const first = await host.spawn(request({ description: 'first' }));
    const second = await host.spawn(request({ description: 'second' }));
    expect(first).toMatchObject({ ok: true, value: { status: 'queued' } });
    expect(second).toMatchObject({ ok: true, value: { status: 'queued' } });
    await settle();
    await expect(host.list({ includeDescendants: false })).resolves.toMatchObject({
      ok: true,
      value: [{ status: 'running' }, { status: 'queued' }],
    });
    releaseFirst();
    if (first.ok) await waitForResult(host, first.value.agentId);
    if (second.ok) await waitForResult(host, second.value.agentId);
  });

  it('removes pre-acceptance aborts and leaves accepted asynchronous work independent', async () => {
    let releaseSnapshot!: () => void;
    let snapshotStarted!: () => void;
    const snapshotStart = new Promise<void>((resolve) => {
      snapshotStarted = resolve;
    });
    const snapshot = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let releaseRun!: () => void;
    const runner: LocalSubagentRunner = async (input) => {
      input.onReady({ steer: async () => {}, cancel: async () => {} });
      await new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      return { result: 'done' };
    };
    const { host } = await harness({ runner });
    host.attachParent({
      ...parentPort([]),
      snapshotContext: async () => {
        snapshotStarted();
        await snapshot;
        return [];
      },
    });
    const controller = new AbortController();
    const starting = host.spawn(request({ inheritContext: true }), controller.signal);
    await snapshotStart;
    controller.abort();
    releaseSnapshot();
    await expect(starting).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    await expect(host.list({ includeDescendants: false })).resolves.toMatchObject({
      ok: true,
      value: [],
    });

    host.attachParent({
      ...parentPort([]),
      snapshotContext: async () => {
        throw new Error('secret provider context failure');
      },
    });
    await expect(host.spawn(request({ inheritContext: true }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'parent_unavailable', message: 'Parent context could not be captured' },
    });
    await expect(host.list({ includeDescendants: false })).resolves.toMatchObject({
      ok: true,
      value: [],
    });

    const acceptedController = new AbortController();
    const accepted = await host.spawn(request(), acceptedController.signal);
    expect(accepted).toMatchObject({ ok: true });
    acceptedController.abort();
    await settle();
    releaseRun();
    if (accepted.ok) {
      await expect(waitForResult(host, accepted.value.agentId)).resolves.toMatchObject({
        ok: true,
        value: { status: 'completed' },
      });
    }
    await settle();
    await host.shutdown();
  });

  it('reports timeout cancellation and max-turn termination', async () => {
    let cancelled = 0;
    const timeoutRunner: LocalSubagentRunner = async (input) => {
      input.onReady({
        steer: async () => {},
        cancel: async () => {
          cancelled += 1;
        },
      });
      await aborted(input.signal);
      return {};
    };
    const timeoutHarness = await harness({ runner: timeoutRunner });
    const timed = await timeoutHarness.host.spawn(request({ timeoutSeconds: 1 }));
    if (timed.ok) {
      await expect(waitForResult(timeoutHarness.host, timed.value.agentId)).resolves.toMatchObject({
        ok: true,
        value: { status: 'timed_out' },
      });
    }
    expect(cancelled).toBe(1);

    const turns = await harness({
      runner: async (input) => {
        input.onReady({ steer: async () => {}, cancel: async () => {} });
        return { turnLimitReached: true };
      },
    });
    const limited = await turns.host.spawn(request({ maxTurns: 1 }));
    if (limited.ok) {
      await expect(waitForResult(turns.host, limited.value.agentId)).resolves.toMatchObject({
        ok: true,
        value: { status: 'cancelled', error: { code: 'turn_limit_reached' } },
      });
    }
  });

  it('returns the latest active record without waiting for completion', async () => {
    const started = deferred();
    const release = deferred();
    const runner: LocalSubagentRunner = async (input) => {
      await input.onReady({ steer: async () => {}, cancel: async () => {} });
      started.resolve();
      await release.promise;
      return { result: 'done' };
    };
    const { host } = await harness({ runner });
    const spawned = await host.spawn(request());
    if (!spawned.ok) return;
    await started.promise;
    await expect(host.getResult(spawned.value.agentId)).resolves.toMatchObject({
      ok: true,
      value: { status: 'running' },
    });
    release.resolve();
    await waitForResult(host, spawned.value.agentId);
  });

  it('provides synchronous direct-child views for the TUI navigator', async () => {
    const release = deferred();
    const models = [{ provider: 'provider', id: 'child-model', reasoning: false }];
    const modelRuntime = {
      getAvailableSnapshot: () => models,
      hasConfiguredAuth: () => true,
      getModel: (provider: string, id: string) => models.find((model) => (
        model.provider === provider && model.id === id
      )),
    } as unknown as ModelRuntime;
    const { host } = await harness({
      modelRuntime,
      runner: async (input) => {
        await input.onReady({ steer: async () => {}, cancel: async () => {} });
        await release.promise;
        return { result: 'done' };
      },
    });
    const spawned = await host.spawn(request({
      description: 'visible child',
      model: 'provider/child-model',
    }));
    if (!spawned.ok) return;
    await settle();

    expect(host.listLocalSubagents()).toEqual([
      expect.objectContaining({
        agentId: spawned.value.agentId,
        description: 'visible child',
        model: 'provider/child-model',
        status: 'running',
      }),
    ]);
    expect(host.getLocalSubagent(spawned.value.agentId)).toMatchObject({
      agentId: spawned.value.agentId,
      model: 'provider/child-model',
      status: 'running',
    });

    release.resolve();
    await waitForResult(host, spawned.value.agentId);
  });

  it('steers queued and running jobs at their safe delivery boundaries', async () => {
    const runningSteers: string[] = [];
    const started: string[] = [];
    let releaseFirst!: () => void;
    const runner: LocalSubagentRunner = async (input) => {
      started.push(input.initialMessage);
      input.onReady({
        steer: async (message) => {
          runningSteers.push(message);
        },
        cancel: async () => {},
      });
      if (input.request.description === 'first') {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return { result: 'done' };
    };
    const { host } = await harness({ runner, concurrency: 1 });
    const first = await host.spawn(request({ description: 'first' }));
    const second = await host.spawn(request({ description: 'second' }));
    if (!first.ok || !second.ok) return;
    await settle();
    await host.steer(first.value.agentId, 'running guidance');
    await host.steer(second.value.agentId, 'queued guidance');
    expect(runningSteers).toEqual(['running guidance']);
    releaseFirst();
    await waitForResult(host, second.value.agentId);
    expect(started.at(-1)).toContain('queued guidance');
  });

  it('shares one nested manager, preserves the root session, and cancels a real descendant', async () => {
    let descendantId: string | undefined;
    const rootSessionIds: string[] = [];
    let descendantStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      descendantStarted = resolve;
    });
    const runner: LocalSubagentRunner = async (input) => {
      rootSessionIds.push(input.rootSessionId);
      input.onReady({ steer: async () => {}, cancel: async () => {} });
      if (input.request.description === 'parent') {
        const child = await input.subagents.spawn(request({ description: 'descendant' }));
        if (child.ok) descendantId = child.value.agentId;
      } else {
        descendantStarted();
      }
      await aborted(input.signal);
      return {};
    };
    const fixture = await harness({ runner, concurrency: 2 });
    const host = fixture.host;
    const parent = await host.spawn(request({ type: 'general', description: 'parent' }));
    if (!parent.ok) return;
    await started;
    await host.cancel(parent.value.agentId, 'stop tree');
    const listed = await host.list({ includeDescendants: true });
    expect(listed).toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({ agentId: parent.value.agentId, rootSessionId: 'root', status: 'cancelled' }),
        expect.objectContaining({ agentId: descendantId, rootSessionId: 'root', parentSessionId: parent.value.agentId, status: 'cancelled' }),
      ]),
    });
    expect(rootSessionIds).toEqual(['root', 'root']);
  });

  it('enforces configured nesting depth without exposing it through host policy', async () => {
    let nested: Awaited<ReturnType<LocalSubagentHost['spawn']>> | undefined;
    const { host } = await harness({
      maxDepth: 1,
      runner: async (input) => {
        await input.onReady({ steer: async () => {}, cancel: async () => {} });
        nested = await input.subagents.spawn(request({ description: 'nested' }));
        return { result: 'done' };
      },
    });

    const parent = await host.spawn(request({ type: 'general' }));
    if (parent.ok) await waitForResult(host, parent.value.agentId);

    expect(nested).toMatchObject({ ok: false, error: { code: 'depth_exceeded' } });
    expect(host.policy).toEqual({
      maxPromptBytes: 128 * 1024,
      maxDescriptionBytes: 512,
      maxSteerBytes: 32 * 1024,
    });
  });

  it('rejects nested spawn after parent cancellation wins control', async () => {
    let nested: Awaited<ReturnType<LocalSubagentHost['spawn']>> | undefined;
    const runner: LocalSubagentRunner = async (input) => {
      await input.onReady({ steer: async () => {}, cancel: async () => {} });
      await aborted(input.signal);
      nested = await input.subagents.spawn(request({ description: 'late child' }));
      return {};
    };
    const fixture = await harness({ runner });
    const host = fixture.host;
    const parent = await host.spawn(request({ type: 'general', description: 'parent' }));
    if (!parent.ok) return;
    await settle();

    await host.cancel(parent.value.agentId, 'stop parent');

    expect(nested).toMatchObject({ ok: false, error: { code: 'parent_unavailable' } });
  });

  it('closes spawn admission and waits for in-flight construction during shutdown', async () => {
    const constructionStarted = deferred();
    const releaseConstruction = deferred();
    const { host } = await harness({
      runner: async () => ({ result: 'unexpected' }),
    });
    host.attachParent({
      ...parentPort([]),
      snapshotContext: async () => {
        constructionStarted.resolve();
        await releaseConstruction.promise;
        return [];
      },
    });
    const spawning = host.spawn(request({ inheritContext: true }));
    await constructionStarted.promise;
    let stopped = false;
    const shutdown = host.shutdown().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    releaseConstruction.resolve();

    await expect(spawning).resolves.toMatchObject({ ok: false, error: { code: 'host_unavailable' } });
    await shutdown;
    await expect(host.list({ includeDescendants: false })).resolves.toMatchObject({
      ok: true,
      value: [],
    });
  });

  it('keeps queued completion intent replayable until durable delivery', async () => {
    const { host } = await harness({
      runner: async (input) => {
        input.onReady({ steer: async () => {}, cancel: async () => {} });
        return { result: 'done' };
      },
    });
    const outcomes = ['queued', 'delivered'] as const;
    const delivered: SubagentCompletionNotice[] = [];
    host.attachParent({
      ...parentPort([]),
      deliverCompletion: async (notice) => {
        delivered.push(notice);
        return outcomes[Math.min(delivered.length - 1, outcomes.length - 1)];
      },
    });
    const spawned = await host.spawn(request());
    if (!spawned.ok) return;
    await waitForResult(host, spawned.value.agentId);
    await vi.waitFor(() => expect(delivered.length).toBeGreaterThanOrEqual(2));
    expect(new Set(delivered.map((notice) => notice.deliveryId)).size).toBe(1);
  });

  it('preserves a completed result while its completion delivery remains unacknowledged', async () => {
    const root = await temporaryDirectory();
    const retainedSession = join(root, 'pending-child.jsonl');
    let deliveryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      deliveryStarted = resolve;
    });
    let releaseDelivery!: (outcome: 'queued') => void;
    const deliveryOutcome = new Promise<'queued'>((resolve) => {
      releaseDelivery = resolve;
    });
    const { host } = await harness({
      root,
      runner: async (input) => {
        await input.onReady({ steer: async () => {}, cancel: async () => {} });
        await writeSessionHeader(retainedSession, root, input.sessionId);
        return { result: 'original result', sessionFile: retainedSession };
      },
    });
    host.attachParent({
      ...parentPort([]),
      deliverCompletion: async () => {
        deliveryStarted();
        return deliveryOutcome;
      },
    });
    const spawned = await host.spawn(request());
    if (!spawned.ok) return;
    await waitForResult(host, spawned.value.agentId);
    await started;

    let steeringSettled = false;
    const steering = host.steer(spawned.value.agentId, 'continue').then((result) => {
      steeringSettled = true;
      return result;
    });
    await settle();
    expect(steeringSettled).toBe(false);
    await expect(host.list({ includeDescendants: false })).resolves.toMatchObject({
      ok: true,
      value: [expect.objectContaining({ status: 'completed', result: 'original result' })],
    });

    releaseDelivery('queued');
    await expect(steering).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_steerable', message: expect.stringContaining('pending delivery') },
    });
    await expect(host.getResult(spawned.value.agentId)).resolves.toMatchObject({
      ok: true,
      value: { status: 'completed', result: 'original result' },
    });
    await host.shutdown();
  });

  it('routes concurrent completed steering into one continued run', async () => {
    const root = await temporaryDirectory();
    const retainedSession = join(root, 'concurrent-child.jsonl');
    const deliveryStarted = deferred();
    let acknowledgeDelivery!: () => void;
    const deliveryOutcome = new Promise<'delivered'>((resolve) => {
      acknowledgeDelivery = () => resolve('delivered');
    });
    const continuationStarted = deferred();
    const releaseContinuation = deferred();
    const continuationMessages: string[] = [];
    let runs = 0;
    const { host } = await harness({
      root,
      runner: async (input) => {
        runs += 1;
        if (!input.sessionFile) {
          await input.onReady({ steer: async () => {}, cancel: async () => {} });
          await writeSessionHeader(retainedSession, root, input.sessionId);
          return { result: 'original result', sessionFile: retainedSession };
        }
        continuationMessages.push(input.initialMessage);
        await input.onReady({
          steer: async (message) => {
            continuationMessages.push(message);
          },
          cancel: async () => {},
        });
        continuationStarted.resolve();
        await releaseContinuation.promise;
        return { result: 'continued result', sessionFile: retainedSession };
      },
    });
    let deliveries = 0;
    host.attachParent({
      ...parentPort([]),
      deliverCompletion: async () => {
        deliveries += 1;
        if (deliveries > 1) return 'delivered';
        deliveryStarted.resolve();
        return deliveryOutcome;
      },
    });
    const spawned = await host.spawn(request());
    if (!spawned.ok) return;
    await waitForResult(host, spawned.value.agentId);
    await deliveryStarted.promise;

    const first = host.steer(spawned.value.agentId, 'first guidance');
    const second = host.steer(spawned.value.agentId, 'second guidance');
    await expect(host.list({ includeDescendants: false })).resolves.toMatchObject({
      ok: true,
      value: [expect.objectContaining({ status: 'completed', result: 'original result' })],
    });
    acknowledgeDelivery();

    const results = await Promise.all([first, second]);
    expect(results).toEqual([
      expect.objectContaining({ ok: true, value: expect.objectContaining({ agentId: spawned.value.agentId }) }),
      expect.objectContaining({ ok: true, value: expect.objectContaining({ agentId: spawned.value.agentId }) }),
    ]);
    await continuationStarted.promise;
    expect(runs).toBe(2);
    const guidance = continuationMessages.join('\n');
    expect(guidance.match(/first guidance/g)).toHaveLength(1);
    expect(guidance.match(/second guidance/g)).toHaveLength(1);

    releaseContinuation.resolve();
    await expect(waitForResult(host, spawned.value.agentId)).resolves.toMatchObject({
      ok: true,
      value: { status: 'completed', result: 'continued result' },
    });
    await host.shutdown();
  });

  it('reconstructs an oversized result from a retained Pi session file', async () => {
    const root = await temporaryDirectory();
    const full = 'full result\n'.repeat(30_000);
    const runner: LocalSubagentRunner = async (input) => {
      input.onReady({ steer: async () => {}, cancel: async () => {} });
      const manager = SessionManager.create(input.cwd, join(root, 'child-sessions'), {
        id: input.sessionId,
      });
      manager.appendMessage(completedAssistantMessage(full));
      return { result: full, sessionFile: manager.getSessionFile() };
    };
    const { host } = await harness({ runner, root });
    const spawned = await host.spawn(request());
    if (!spawned.ok) return;
    const completed = await waitForResult(host, spawned.value.agentId);
    expect(completed).toMatchObject({ ok: true, value: { result: full } });
    const retained = await host.getResult(spawned.value.agentId);
    expect(retained).toMatchObject({ ok: true, value: { result: full } });
  });

  it('awaits clean cancellation before shutdown persistence completes', async () => {
    const root = await temporaryDirectory();
    let releaseCancellation!: () => void;
    const runner: LocalSubagentRunner = async (input) => {
      const cancellation = new Promise<void>((resolve) => {
        releaseCancellation = resolve;
      });
      input.onReady({ steer: async () => {}, cancel: async () => cancellation });
      await aborted(input.signal);
      await cancellation;
      return {};
    };
    const first = await harness({ runner, root });
    const spawned = await first.host.spawn(request());
    await settle();
    let stopped = false;
    const shutdown = first.host.shutdown().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    releaseCancellation();
    await shutdown;
    const second = await harness({ runner, root });
    if (spawned.ok) {
      await expect(second.host.getResult(spawned.value.agentId)).resolves.toMatchObject({
        ok: true,
        value: { status: 'cancelled', error: { message: 'Local host exited' } },
      });
    }
  });

});

async function harness(options: {
  runner: LocalSubagentRunner;
  concurrency?: number;
  maxDepth?: number;
  root?: string;
  modelRuntime?: ModelRuntime;
}) {
  const root = options.root ?? await temporaryDirectory();
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);
  const modelRuntime = options.modelRuntime
    ?? await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null });
  const host = await LocalSubagentHost.create({
    sessionId: 'root',
    cwd,
    agentDir,
    homeDir: root,
    modelRuntime,
    settingsManager: SettingsManager.inMemory(),
    extensionPackages: [],
    importExtension: async () => ({}),
    settings: { concurrency: options.concurrency ?? 4, maxDepth: options.maxDepth ?? 3 },
    runChild: options.runner,
  });
  return { host };
}

function request(overrides: Partial<SubagentSpawnRequest> = {}): SubagentSpawnRequest {
  return {
    type: 'reviewer',
    description: 'review',
    prompt: 'Review this',
    inheritContext: false,
    ...overrides,
  };
}

function parentPort(notices: SubagentCompletionNotice[]): SubagentParentPort {
  return {
    snapshotContext: async () => [],
    deliverCompletion: async (notice) => {
      notices.push(notice);
      return 'delivered';
    },
  };
}

function completedAssistantMessage(text: string) {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    api: 'anthropic-messages' as const,
    provider: 'anthropic',
    model: 'test-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop' as const,
    timestamp: Date.now(),
  };
}

function sessionHeader(cwd: string, sessionId: string): string {
  return JSON.stringify({
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd,
  });
}

async function writeSessionHeader(path: string, cwd: string, sessionId: string): Promise<void> {
  await writeFile(path, `${sessionHeader(cwd, sessionId)}\n`);
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-subagents-'));
  temporaryPaths.push(path);
  return path;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function waitForResult(host: SubagentHost, agentId: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await host.getResult(agentId);
    if (
      !result.ok
      || ['completed', 'failed', 'timed_out', 'cancelled'].includes(result.value.status)
    ) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Subagent did not finish: ${agentId}`);
}

async function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
