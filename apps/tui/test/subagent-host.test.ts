import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAssistantMessageEventStream,
  type ExtensionPackageImporter,
  type FelanExtensionAPI,
  type SavingsMeasurement,
  type SavingsReporterProvider,
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
  createLocalSubagentExtensionImporter,
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

  it('binds the configured output style into child extension composition', async () => {
    const { host, modelRuntime } = await harness({
      runner: async () => ({ result: 'unused' }),
    });
    const importer = createLocalSubagentExtensionImporter({
      modelRuntime,
      importExtension: async () => {
        throw new Error('The generic importer must not load output style');
      },
      outputStyle: 'explanatory',
    }, host);
    const imported = await importer('@felan-ai/ext-output-style') as {
      default: (pi: FelanExtensionAPI) => void;
    };
    let handler: ((event: { systemPrompt: string }) => { systemPrompt: string }) | undefined;
    imported.default({
      config: { style: 'explanatory' },
      on: ((event: string, registered: typeof handler) => {
        if (event === 'before_agent_start') handler = registered;
      }) as FelanExtensionAPI['on'],
    } as FelanExtensionAPI);

    expect(handler?.({ systemPrompt: 'Child base prompt' }).systemPrompt).toContain(
      'Explain the reasoning and important tradeoffs',
    );
    await host.shutdown();
  });

  it('binds concise output style into child extension composition', async () => {
    const { host, modelRuntime } = await harness({
      runner: async () => ({ result: 'unused' }),
    });
    const importer = createLocalSubagentExtensionImporter({
      modelRuntime,
      importExtension: async () => {
        throw new Error('The generic importer must not load output style');
      },
      outputStyle: 'concise',
    }, host);
    const imported = await importer('@felan-ai/ext-output-style') as {
      default: (pi: FelanExtensionAPI) => void;
    };
    let handler: ((event: { systemPrompt: string }) => { systemPrompt: string }) | undefined;
    imported.default({
      config: { style: 'concise' },
      on: ((event: string, registered: typeof handler) => {
        if (event === 'before_agent_start') handler = registered;
      }) as FelanExtensionAPI['on'],
    } as FelanExtensionAPI);

    expect(handler?.({ systemPrompt: 'Child base prompt' }).systemPrompt).toContain(
      'Keep technical terms, code, commands, paths, identifiers, API names, numbers, units, and exact error messages unchanged',
    );
    await host.shutdown();
  });

  it('binds custom output-style instructions into child extension composition', async () => {
    const { host, modelRuntime } = await harness({
      runner: async () => ({ result: 'unused' }),
    });
    const importer = createLocalSubagentExtensionImporter({
      modelRuntime,
      importExtension: async () => {
        throw new Error('The generic importer must not load output style');
      },
      outputStyle: 'custom',
    }, host);
    const imported = await importer('@felan-ai/ext-output-style') as {
      default: (pi: FelanExtensionAPI) => void;
    };
    let handler: ((event: { systemPrompt: string }) => { systemPrompt: string }) | undefined;
    imported.default({
      config: {
        style: 'custom',
        instructions: 'Child custom instructions.',
      },
      on: ((event: string, registered: typeof handler) => {
        if (event === 'before_agent_start') handler = registered;
      }) as FelanExtensionAPI['on'],
    } as FelanExtensionAPI);

    expect(handler?.({ systemPrompt: 'Child base prompt' }).systemPrompt).toContain(
      '<output_style>\nChild custom instructions.\n</output_style>',
    );
    await host.shutdown();
  });

  it('awaits child extension shutdown before completing the subagent', async () => {
    const response = createAssistantMessageEventStream();
    const shutdownStarted = deferred();
    const allowShutdown = deferred();
    let requests = 0;
    const model = {
      id: 'test-model',
      name: 'Test Model',
      api: 'anthropic-messages',
      provider: 'test-provider',
      baseUrl: 'https://example.invalid',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    };
    const modelRuntime = {
      getAvailableSnapshot: () => [model],
      hasConfiguredAuth: () => true,
      getModel: (provider: string, id: string) => (
        provider === model.provider && id === model.id ? model : undefined
      ),
      streamSimple: () => {
        requests += 1;
        return response;
      },
    } as unknown as ModelRuntime;
    const importExtension: ExtensionPackageImporter = async () => ({
      default: (pi: FelanExtensionAPI) => {
        pi.on('session_shutdown', async () => {
          shutdownStarted.resolve();
          await allowShutdown.promise;
        });
      },
    });
    const { host } = await harness({
      modelRuntime,
      extensionPackages: ['test-lifecycle-extension'],
      importExtension,
    });

    try {
      const spawned = await host.spawn(request({ model: `${model.provider}/${model.id}` }));
      expect(spawned).toMatchObject({ ok: true });
      if (!spawned.ok) return;
      await vi.waitFor(() => expect(requests).toBe(1));
      pushUsageResponse(response, {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      });
      await shutdownStarted.promise;

      await expect(host.getResult(spawned.value.agentId)).resolves.toMatchObject({
        ok: true,
        value: { status: 'running' },
      });
      allowShutdown.resolve();
      await expect(waitForResult(host, spawned.value.agentId)).resolves.toMatchObject({
        ok: true,
        value: { status: 'completed' },
      });
    } finally {
      allowShutdown.resolve();
      await host.shutdown();
    }
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
    expect(cancelled).toMatchObject({
      ok: true,
      value: { status: 'cancelled', error: { code: 'cancelled_by_parent' } },
    });
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
        error: { code: 'host_shutdown' },
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

  it('retains a persisted session path so an interrupted child can be continued', async () => {
    const root = await temporaryDirectory();
    const sessionId = 'interrupted-child';
    const sessionFile = join(root, 'agent', 'subagents', 'root', 'sessions', `${sessionId}.jsonl`);
    const recordsFile = join(root, 'agent', 'subagents', 'root', 'records.json');
    await mkdir(join(root, 'agent', 'subagents', 'root', 'sessions'), { recursive: true });
    await writeSessionHeader(sessionFile, join(root, 'workspace'), sessionId);
    await writeFile(recordsFile, `${JSON.stringify({
      version: 1,
      children: [{
        record: {
          agentId: sessionId,
          parentSessionId: 'root',
          rootSessionId: 'root',
          type: 'reviewer',
          description: 'interrupted review',
          status: 'running',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        request: request(),
        depth: 1,
        sessionFile,
        deliveryId: 'delivery-interrupted',
        completionPending: false,
      }],
    })}\n`);

    let continued = false;
    const fixture = await harness({
      root,
      runner: async (input) => {
        continued = input.sessionFile === sessionFile;
        await input.onReady({ steer: async () => {}, cancel: async () => {} });
        return { result: 'recovered result', sessionFile };
      },
    });
    await expect(fixture.host.getResult(sessionId)).resolves.toMatchObject({
      ok: true,
      value: { status: 'cancelled', error: { code: 'host_shutdown' } },
    });
    await expect(fixture.host.steer(sessionId, 'continue')).resolves.toMatchObject({
      ok: true,
      value: { status: 'queued', agentId: sessionId },
    });
    await expect(waitForResult(fixture.host, sessionId)).resolves.toMatchObject({
      ok: true,
      value: { status: 'completed', result: 'recovered result' },
    });
    expect(continued).toBe(true);
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
        value: { status: 'timed_out', error: { code: 'timed_out' } },
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

  it('keeps model failures distinct and allows explicit continuation with retained history', async () => {
    const root = await temporaryDirectory();
    const retainedSession = join(root, 'failed-child.jsonl');
    let runs = 0;
    const fixture = await harness({
      root,
      runner: async (input) => {
        runs += 1;
        await input.onReady({ steer: async () => {}, cancel: async () => {} });
        await writeSessionHeader(retainedSession, root, input.sessionId);
        return input.sessionFile
          ? { result: 'continued result', sessionFile: retainedSession }
          : {
              error: { code: 'model_request_failed', message: 'Model request failed: fetch failed' },
              sessionFile: retainedSession,
            };
      },
    });
    const spawned = await fixture.host.spawn(request());
    if (!spawned.ok) return;

    await expect(waitForResult(fixture.host, spawned.value.agentId)).resolves.toMatchObject({
      ok: true,
      value: {
        status: 'failed',
        error: { code: 'model_request_failed' },
      },
    });
    await expect(fixture.host.steer(spawned.value.agentId, 'continue')).resolves.toMatchObject({
      ok: true,
      value: { status: 'queued', agentId: spawned.value.agentId },
    });
    await expect(waitForResult(fixture.host, spawned.value.agentId)).resolves.toMatchObject({
      ok: true,
      value: { status: 'completed', result: 'continued result' },
    });
    expect(runs).toBe(2);
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
    const root = await temporaryDirectory();
    const sessionDirectory = join(root, 'child-sessions');
    let descendantId: string | undefined;
    const rootSessionIds: string[] = [];
    let descendantStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      descendantStarted = resolve;
    });
    const runner: LocalSubagentRunner = async (input) => {
      rootSessionIds.push(input.rootSessionId);
      const manager = SessionManager.create(input.cwd, sessionDirectory, { id: input.sessionId });
      manager.appendMessage(usageAssistantMessage({
        input: input.depth,
        output: input.depth,
        cacheRead: 0,
        cacheWrite: 0,
        cost: input.depth / 10,
      }));
      input.onReady({ steer: async () => {}, cancel: async () => {} });
      if (input.request.description === 'parent') {
        const child = await input.subagents.spawn(request({ description: 'descendant' }));
        if (child.ok) descendantId = child.value.agentId;
      } else {
        descendantStarted();
      }
      await aborted(input.signal);
      return { sessionFile: manager.getSessionFile() };
    };
    const fixture = await harness({ runner, concurrency: 2, root });
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
    expect(host.getUsage()).toMatchObject({ input: 3, output: 3 });
    expect(host.getUsage().cost).toBeCloseTo(0.3);
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

  it('retries transient unavailable completion delivery with the same delivery ID', async () => {
    const delivered: SubagentCompletionNotice[] = [];
    let attempts = 0;
    const fixture = await harness({ runner: async (input) => {
      await input.onReady({ steer: async () => {}, cancel: async () => {} });
      return { result: 'done' };
    } });
    fixture.host.attachParent({
      ...parentPort(delivered),
      deliverCompletion: async (notice) => {
        attempts += 1;
        if (attempts === 1) return 'unavailable';
        delivered.push(notice);
        return 'delivered';
      },
    });
    const spawned = await fixture.host.spawn(request());
    if (!spawned.ok) return;
    await waitForResult(fixture.host, spawned.value.agentId);
    await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 1_000 });
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(delivered[0]?.deliveryId).toBeTruthy();
  });

  it('continues a retained result while its completion delivery remains unacknowledged', async () => {
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
    const acknowledged: string[] = [];
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
      acknowledgeCompletion: (deliveryId) => acknowledged.push(deliveryId),
    });
    const spawned = await host.spawn(request());
    if (!spawned.ok) return;
    await waitForResult(host, spawned.value.agentId);
    await started;

    const steering = host.steer(spawned.value.agentId, 'continue');
    await expect(steering).resolves.toMatchObject({
      ok: true,
      value: { status: 'queued', agentId: spawned.value.agentId },
    });
    await expect(host.list({ includeDescendants: false })).resolves.toMatchObject({
      ok: true,
      value: [expect.objectContaining({ status: 'running' })],
    });

    releaseDelivery('queued');
    await expect(waitForResult(host, spawned.value.agentId)).resolves.toMatchObject({
      ok: true,
      value: { status: 'completed', result: 'original result' },
    });
    expect(acknowledged).toHaveLength(1);
    expect(acknowledged[0]).toBeTruthy();
    await host.shutdown();
  });

  it('acknowledges only a terminal completion when explicitly requested', async () => {
    const notices: SubagentCompletionNotice[] = [];
    const acknowledgeCompletion = vi.fn();
    const { host } = await harness({
      runner: async (input) => {
        await input.onReady({ steer: async () => {}, cancel: async () => {} });
        return { result: 'done' };
      },
    });
    host.attachParent({
      deliverCompletion: async (notice) => {
        notices.push(notice);
        return 'queued';
      },
      acknowledgeCompletion,
    });
    const spawned = await host.spawn(request());
    if (!spawned.ok) return;
    await waitForResult(host, spawned.value.agentId);

    await expect(host.getResult(spawned.value.agentId, { acknowledge: true })).resolves.toMatchObject({
      ok: true,
      value: { status: 'completed', result: 'done' },
    });
    expect(acknowledgeCompletion).toHaveBeenCalledWith(expect.any(String));
    await expect(host.getResult(spawned.value.agentId, { acknowledge: true })).resolves.toMatchObject({
      ok: true,
      value: { status: 'completed', result: 'done' },
    });
    expect(acknowledgeCompletion).toHaveBeenCalledOnce();
    await host.shutdown();
  });

  it('aggregates child usage and restores it from retained session files', async () => {
    const root = await temporaryDirectory();
    const sessionDirectory = join(root, 'child-sessions');
    const runner: LocalSubagentRunner = async (input) => {
      const manager = SessionManager.create(input.cwd, sessionDirectory, { id: input.sessionId });
      manager.appendMessage(usageAssistantMessage({
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
        cost: 0.75,
      }));
      return { result: 'done', sessionFile: manager.getSessionFile() };
    };
    const first = await harness({ runner, root });
    const spawned = await first.host.spawn(request());
    if (!spawned.ok) return;
    await waitForResult(first.host, spawned.value.agentId);

    expect(first.host.getUsage()).toEqual({
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      cacheWrite1h: 0,
      cost: 0.75,
    });
    expect(first.host.getLocalSubagent(spawned.value.agentId)).toMatchObject({
      usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 0.75 },
    });
    await first.host.shutdown();

    const second = await harness({ runner, root });
    expect(second.host.getUsage()).toEqual({
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      cacheWrite1h: 0,
      cost: 0.75,
    });
    expect(second.host.getLocalSubagent(spawned.value.agentId)).toMatchObject({
      usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 0.75 },
    });
    await second.host.shutdown();
  });

  it('reports live usage across tool turns and a continued run without double-counting', async () => {
    const responses = Array.from({ length: 4 }, () => createAssistantMessageEventStream());
    let responseIndex = 0;
    const model = {
      id: 'test-model',
      name: 'Test Model',
      api: 'anthropic-messages',
      provider: 'test-provider',
      baseUrl: 'https://example.invalid',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    };
    const modelRuntime = {
      getAvailableSnapshot: () => [model],
      hasConfiguredAuth: () => true,
      getModel: (provider: string, id: string) => (
        provider === model.provider && id === model.id ? model : undefined
      ),
      streamSimple: () => responses[responseIndex++]!,
    } as unknown as ModelRuntime;
    const { host } = await harness({ modelRuntime });
    const spawned = await host.spawn(request({ model: `${model.provider}/${model.id}` }));
    expect(spawned).toMatchObject({ ok: true });
    if (!spawned.ok) return;

    await vi.waitFor(() => {
      expect(responseIndex).toBe(1);
    });
    pushUsageResponse(responses[0]!, {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      cost: 0.75,
    }, 'ls-1');
    await vi.waitFor(() => {
      expect(responseIndex).toBe(2);
    });
    expect(host.getLocalSubagent(spawned.value.agentId)).toMatchObject({
      status: 'running',
      usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 0.75 },
    });

    pushUsageResponse(responses[1]!, {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      cost: 0.25,
    });
    await waitForResult(host, spawned.value.agentId);
    expect(host.getUsage()).toEqual({
      input: 11,
      output: 22,
      cacheRead: 33,
      cacheWrite: 44,
      cacheWrite1h: 0,
      cost: 1,
    });

    await host.steer(spawned.value.agentId, 'continue');
    await vi.waitFor(() => {
      expect(responseIndex).toBe(3);
    });
    pushUsageResponse(responses[2]!, {
      input: 5,
      output: 6,
      cacheRead: 7,
      cacheWrite: 8,
      cost: 0.5,
    }, 'ls-2');
    await vi.waitFor(() => {
      expect(responseIndex).toBe(4);
    });
    expect(host.getLocalSubagent(spawned.value.agentId)).toMatchObject({
      status: 'running',
      usage: { input: 16, output: 28, cacheRead: 40, cacheWrite: 52, cost: 1.5 },
    });

    pushUsageResponse(responses[3]!, {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      cost: 0.125,
    });
    await waitForResult(host, spawned.value.agentId);

    expect(host.getUsage()).toEqual({
      input: 26,
      output: 48,
      cacheRead: 70,
      cacheWrite: 92,
      cacheWrite1h: 0,
      cost: 1.625,
    });
    await host.shutdown();
  });

  it('reports completed explore usage as an incremental parent-model reprice', async () => {
    const root = await temporaryDirectory();
    const sessionDirectory = join(root, 'routing-sessions');
    const reports: SavingsMeasurement[] = [];
    const savings: SavingsReporterProvider = {
      createReporter: vi.fn((producerId) => ({
        report: async (measurement) => {
          expect(producerId).toBe('@felan-ai/ext-subagents');
          reports.push(measurement);
        },
      })),
    };
    let invocation = 0;
    const runner: LocalSubagentRunner = async (input) => {
      const manager = input.sessionFile
        ? SessionManager.open(input.sessionFile)
        : SessionManager.create(input.cwd, sessionDirectory, { id: input.sessionId });
      manager.appendMessage(usageAssistantMessage(invocation++ === 0
        ? { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 5, cost: 0.75 }
        : { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 1, cost: 0.25 }));
      return { result: 'explored', sessionFile: manager.getSessionFile() };
    };
    const first = await harness({
      runner,
      root,
      savings,
      modelRuntime: routingModelRuntime(),
    });
    const spawned = await first.host.spawn(request({
      type: 'explore',
      parentModel: 'test/parent',
      model: 'test/child',
    }));
    if (!spawned.ok) return;
    await waitForResult(first.host, spawned.value.agentId);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({
      category: 'model-routing',
      operation: 'explore-child',
      baseline: {
        model: { provider: 'test', id: 'parent' },
        tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 5 },
      },
      actual: {
        model: { provider: 'test', id: 'child' },
        tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 5 },
        costUsd: 0.75,
      },
      basis: { kind: 'estimated-baseline', method: 'parent-model-reprice-observed-child-usage-v1' },
      dimensions: { techniques: ['explore', 'same-usage-reprice'] },
    });

    await first.host.shutdown();
    const second = await harness({
      runner,
      root,
      savings,
      modelRuntime: routingModelRuntime(),
    });
    await second.host.steer(spawned.value.agentId, 'continue');
    await waitForResult(second.host, spawned.value.agentId);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({
      baseline: { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 1 } },
      actual: {
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 1 },
        costUsd: 0.25,
      },
    });
    await second.host.shutdown();
  });

  it('does not include a failed explore interval in a later successful continuation', async () => {
    const root = await temporaryDirectory();
    const sessionDirectory = join(root, 'routing-sessions');
    const report = vi.fn(async () => undefined);
    let invocation = 0;
    const runner: LocalSubagentRunner = async (input) => {
      const manager = input.sessionFile
        ? SessionManager.open(input.sessionFile)
        : SessionManager.create(input.cwd, sessionDirectory, { id: input.sessionId });
      const failed = invocation++ === 0;
      manager.appendMessage(usageAssistantMessage(failed
        ? { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 0.75 }
        : { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.25 }));
      return failed
        ? { error: { code: 'model_request_failed', message: 'failed' }, sessionFile: manager.getSessionFile() }
        : { result: 'recovered', sessionFile: manager.getSessionFile() };
    };
    const { host } = await harness({
      runner,
      root,
      savings: { createReporter: () => ({ report }) },
      modelRuntime: routingModelRuntime(),
    });
    const spawned = await host.spawn(request({
      type: 'explore', parentModel: 'test/parent', model: 'test/child',
    }));
    if (!spawned.ok) return;
    await waitForResult(host, spawned.value.agentId);
    expect(report).not.toHaveBeenCalled();

    await host.steer(spawned.value.agentId, 'continue');
    await waitForResult(host, spawned.value.agentId);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      baseline: expect.objectContaining({
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 0 },
      }),
      actual: expect.objectContaining({
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 0 },
        costUsd: 0.25,
      }),
    }));
    await host.shutdown();
  });

  it('does not claim routing savings for unsuccessful, non-explore, or same-model children', async () => {
    const report = vi.fn(async () => { throw new Error('unavailable'); });
    const savings: SavingsReporterProvider = { createReporter: () => ({ report }) };
    const runner: LocalSubagentRunner = async (input) => {
      const sessionDirectory = join(input.cwd, 'sessions');
      const manager = SessionManager.create(input.cwd, sessionDirectory, { id: input.sessionId });
      manager.appendMessage(usageAssistantMessage({
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1,
      }));
      return input.request.description === 'failed'
        ? { error: { code: 'model_request_failed', message: 'failed' }, sessionFile: manager.getSessionFile() }
        : { result: 'done', sessionFile: manager.getSessionFile() };
    };
    const { host } = await harness({ runner, savings, modelRuntime: routingModelRuntime() });

    const eligible = await host.spawn(request({
      type: 'explore', description: 'eligible', parentModel: 'test/parent', model: 'test/child',
    }));
    const failed = await host.spawn(request({
      type: 'explore', description: 'failed', parentModel: 'test/parent', model: 'test/child',
    }));
    const same = await host.spawn(request({
      type: 'explore', description: 'same', parentModel: 'test/child', model: 'test/child',
    }));
    const reviewer = await host.spawn(request({
      type: 'reviewer', description: 'reviewer', parentModel: 'test/parent', model: 'test/child',
    }));
    for (const result of [eligible, failed, same, reviewer]) {
      if (result.ok) await waitForResult(host, result.value.agentId);
    }

    expect(report).toHaveBeenCalledOnce();
    expect(eligible.ok && (await host.getResult(eligible.value.agentId))).toMatchObject({
      ok: true,
      value: { status: 'completed' },
    });
    await host.shutdown();
  });

  it('reserves a tool-free synthesis turn at the max-turn boundary', async () => {
    const responses = [createAssistantMessageEventStream(), createAssistantMessageEventStream()];
    const contexts: Array<{ tools: readonly unknown[]; messages: readonly unknown[] }> = [];
    let responseIndex = 0;
    const model = {
      id: 'test-model',
      name: 'Test Model',
      api: 'anthropic-messages',
      provider: 'test-provider',
      baseUrl: 'https://example.invalid',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    };
    const modelRuntime = {
      getAvailableSnapshot: () => [model],
      hasConfiguredAuth: () => true,
      getModel: (provider: string, id: string) => (
        provider === model.provider && id === model.id ? model : undefined
      ),
      streamSimple: (_model: unknown, context: { tools: readonly unknown[]; messages: readonly unknown[] }) => {
        contexts.push(context);
        return responses[responseIndex++]!;
      },
    } as unknown as ModelRuntime;
    const { host } = await harness({ modelRuntime });
    const spawned = await host.spawn(request({ maxTurns: 2, model: `${model.provider}/${model.id}` }));
    expect(spawned).toMatchObject({ ok: true });
    if (!spawned.ok) return;

    await vi.waitFor(() => expect(responseIndex).toBe(1));
    pushUsageResponse(responses[0]!, {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    }, 'tool-1');
    await vi.waitFor(() => expect(responseIndex).toBe(2));
    expect(contexts[1]!.tools).toEqual([]);
    expect(contexts[1]!.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('Stop using tools') }),
      ]),
    });
    pushUsageResponse(responses[1]!, {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    });
    await expect(waitForResult(host, spawned.value.agentId)).resolves.toMatchObject({
      ok: true,
      value: { status: 'completed' },
    });
  });

  it('does not double-count a continued child session', async () => {
    const root = await temporaryDirectory();
    const sessionDirectory = join(root, 'child-sessions');
    const runner: LocalSubagentRunner = async (input) => {
      const manager = input.sessionFile
        ? SessionManager.open(input.sessionFile)
        : SessionManager.create(input.cwd, sessionDirectory, { id: input.sessionId });
      if (!input.sessionFile) {
        manager.appendMessage(usageAssistantMessage({
          input: 10,
          output: 20,
          cacheRead: 30,
          cacheWrite: 40,
          cost: 0.75,
        }));
      }
      return { result: 'done', sessionFile: manager.getSessionFile() };
    };
    const { host } = await harness({ runner, root });
    const spawned = await host.spawn(request());
    if (!spawned.ok) return;
    await waitForResult(host, spawned.value.agentId);
    await host.steer(spawned.value.agentId, 'continue');
    await waitForResult(host, spawned.value.agentId);

    expect(host.getUsage()).toEqual({
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      cacheWrite1h: 0,
      cost: 0.75,
    });
    await host.shutdown();
  });

  it('does not recreate or count missing and malformed retained session files', async () => {
    const root = await temporaryDirectory();
    const sessionDirectory = join(root, 'child-sessions');
    let sessionFile = '';
    const runner: LocalSubagentRunner = async (input) => {
      const manager = SessionManager.create(input.cwd, sessionDirectory, { id: input.sessionId });
      manager.appendMessage(usageAssistantMessage({
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
        cost: 0.75,
      }));
      sessionFile = manager.getSessionFile()!;
      return { result: 'done', sessionFile };
    };
    const first = await harness({ runner, root });
    const spawned = await first.host.spawn(request());
    if (!spawned.ok) return;
    await waitForResult(first.host, spawned.value.agentId);
    await first.host.shutdown();

    await rm(sessionFile);
    const missing = await harness({ runner, root });
    expect(missing.host.getUsage()).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      cost: 0,
    });
    expect(missing.host.getLocalSubagent(spawned.value.agentId)?.usage).toBeUndefined();
    await expect(readFile(sessionFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await missing.host.shutdown();

    await writeFile(sessionFile, '{"type":"not-a-session"}\n');
    const malformed = await harness({ runner, root });
    expect(malformed.host.getUsage().cost).toBe(0);
    expect(malformed.host.getLocalSubagent(spawned.value.agentId)?.usage).toBeUndefined();
    expect(await readFile(sessionFile, 'utf8')).toBe('{"type":"not-a-session"}\n');
    await malformed.host.shutdown();
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
  runner?: LocalSubagentRunner;
  concurrency?: number;
  maxDepth?: number;
  root?: string;
  modelRuntime?: ModelRuntime;
  savings?: SavingsReporterProvider;
  extensionPackages?: readonly string[];
  importExtension?: ExtensionPackageImporter;
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
    extensionPackages: options.extensionPackages ?? [],
    importExtension: options.importExtension ?? (async () => ({})),
    settings: { concurrency: options.concurrency ?? 4, maxDepth: options.maxDepth ?? 3 },
    ...(options.savings === undefined ? {} : { savings: options.savings }),
    ...(options.runner === undefined ? {} : { runChild: options.runner }),
  });
  return { host, modelRuntime };
}

function request(overrides: Partial<SubagentSpawnRequest> = {}): SubagentSpawnRequest {
  return {
    type: 'reviewer',
    description: 'review',
    prompt: 'Review this',
    ...overrides,
  };
}

function parentPort(notices: SubagentCompletionNotice[]): SubagentParentPort {
  return {
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

interface UsageFixture {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  cost: number;
}

function usageAssistantMessage(usage: UsageFixture) {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: 'usage' }],
    api: 'anthropic-messages' as const,
    provider: 'anthropic',
    model: 'test-model',
    usage: {
      ...usage,
      totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite + (usage.cacheWrite1h ?? 0),
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: usage.cost,
      },
    },
    stopReason: 'stop' as const,
    timestamp: Date.now(),
  };
}

function routingModelRuntime(): ModelRuntime {
  const models = ['parent', 'child'].map((id) => ({
    id,
    name: id,
    api: 'anthropic-messages',
    provider: 'test',
    baseUrl: 'https://example.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: id === 'parent' ? 10 : 1, output: id === 'parent' ? 20 : 2, cacheRead: 0.5, cacheWrite: 3 },
    contextWindow: 100_000,
    maxTokens: 4_096,
  }));
  return {
    getAvailableSnapshot: () => models,
    hasConfiguredAuth: () => true,
    getModel: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
  } as unknown as ModelRuntime;
}

function pushUsageResponse(
  response: ReturnType<typeof createAssistantMessageEventStream>,
  usage: UsageFixture,
  toolCallId?: string,
): void {
  if (toolCallId === undefined) {
    const message = usageAssistantMessage(usage);
    response.push({ type: 'start', partial: message });
    response.push({ type: 'done', reason: 'stop', message });
    return;
  }

  const message = {
    ...usageAssistantMessage(usage),
    content: [{ type: 'toolCall' as const, id: toolCallId, name: 'ls', arguments: { path: '.' } }],
    stopReason: 'toolUse' as const,
  };
  response.push({ type: 'start', partial: message });
  response.push({ type: 'done', reason: 'toolUse', message });
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
