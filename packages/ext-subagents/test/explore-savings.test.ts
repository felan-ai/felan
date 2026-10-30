import type {
  AgentRuntimeStorage,
  ExtensionContext,
  FelanExtensionAPI,
  SavingsMeasurement,
  SessionExecution,
  SessionExecutionsOptions,
  SessionsEvent,
  SessionsService,
  ToolDefinition,
} from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { registerExploreRoutingSavings } from '../src/explore-savings.js';
import { createSubagentsExtension } from '../src/index.js';

const parent = { provider: 'test', id: 'parent' };
const child = { provider: 'test', id: 'child' };
const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, cacheWrite1h: 1, cost: 0.4 };
const path = 'savings/explore-routing/child.json';

function record(overrides: Partial<SessionExecution> = {}): SessionExecution {
  return { id: 'child', parent: 'parent', label: 'explore', state: 'running', model: child, ...overrides };
}

function completed(overrides: Partial<SessionExecution> = {}): SessionExecution {
  return record({ state: 'completed', result: { text: 'Found it', truncated: false }, usage, ...overrides });
}

function memoryStorage() {
  const files = new Map<string, Uint8Array>();
  const storage: AgentRuntimeStorage = {
    root: '/session',
    readFile: vi.fn(async name => {
      const bytes = files.get(name);
      if (!bytes) throw new Error('missing');
      return bytes;
    }),
    writeFile: vi.fn(async (name, bytes) => { files.set(name, bytes); }),
    appendFile: vi.fn(async () => {}), listFiles: vi.fn(async () => [...files.keys()]),
    mkdir: vi.fn(async () => {}), remove: vi.fn(async name => { files.delete(name); }),
  };
  return { storage, files };
}

function fixture(options: {
  persistence?: ReturnType<typeof memoryStorage>;
  initial?: readonly SessionExecution[];
  currentId?: string;
  pageSize?: number;
  integrated?: boolean;
} = {}) {
  const persistence = options.persistence ?? memoryStorage();
  const currentId = options.currentId ?? 'parent';
  let records = options.initial ?? [];
  const listeners = new Set<(event: SessionsEvent) => void>();
  const hooks = new Map<string, () => Promise<void>>();
  const tools = new Map<string, ToolDefinition<any, any, any>>();
  const sessions = {
    current: { id: currentId, root: 'parent' },
    executions: vi.fn(async (query?: SessionExecutionsOptions) => {
      const visible = records.filter(item => query?.includeDescendants || item.parent === currentId);
      const offset = Number(query?.cursor ?? 0);
      const end = offset + (options.pageSize ?? 100);
      return { items: structuredClone(visible.slice(offset, end)), ...(end < visible.length ? { nextCursor: String(end) } : {}) };
    }),
    subscribe: vi.fn((listener: (event: SessionsEvent) => void) => {
      listeners.add(listener); return () => { listeners.delete(listener); };
    }),
    create: vi.fn(async () => {
      const created = record();
      records = [...records, created];
      return created;
    }),
  };
  const report = vi.fn(async (_measurement: SavingsMeasurement) => {});
  const storageFactory = vi.fn(() => persistence.storage);
  const pi = {
    runtime: { storage: storageFactory }, savings: { report },
    on: (name: string, handler: () => Promise<void>) => hooks.set(name, handler),
    registerTool: (tool: ToolDefinition<any, any, any>) => tools.set(tool.name, tool),
    registerCapability() {}, getThinkingLevel: () => 'off',
  } as unknown as FelanExtensionAPI;
  const service = sessions as unknown as SessionsService;
  const tracker = options.integrated ? undefined : registerExploreRoutingSavings(pi, service);
  if (options.integrated) {
    createSubagentsExtension(service, [
      { descriptor: { id: 'explore', description: 'Inspect', model: 'test/child', allowNesting: false }, prompt: 'Inspect' },
      { descriptor: { id: 'general', description: 'Work', model: 'test/child', allowNesting: true }, prompt: 'Work' },
    ])(pi);
  }
  function emit(next: readonly SessionExecution[], event: SessionsEvent = { kind: 'execution', id: 'child' }) {
    records = next;
    for (const listener of listeners) listener(event);
  }
  return { ...persistence, pi, tracker, sessions, report, storageFactory, hooks, tools, listeners, emit,
    start: () => hooks.get('session_start')!(), shutdown: () => hooks.get('session_shutdown')!(),
    async observe(next: readonly SessionExecution[]) { emit(next); await tracker!.settle(); },
  };
}

async function spawn(f: ReturnType<typeof fixture>, context: Partial<ExtensionContext> = { model: parent as ExtensionContext['model'] }, type = 'explore') {
  return f.tools.get('Agent')!.execute('call', { subagent_type: type, prompt: 'Find it', description: 'Inspect' },
    undefined, undefined, context as Parameters<ToolDefinition['execute']>[4]);
}

async function recordParent(f: ReturnType<typeof fixture>, id = 'child', model = parent) {
  await f.tracker!.trackSpawn(model, async () => record({ id }));
}

describe('explore routing savings', () => {
  it('reports the exact cross-model measurement once for repeated completion events', async () => {
    const f = fixture();
    await f.start();
    await recordParent(f);
    f.emit([completed()]);
    f.emit([completed()]);
    await f.tracker!.settle();
    await f.observe([completed()]);
    const { cost, ...tokens } = usage;
    expect(f.report).toHaveBeenCalledExactlyOnceWith({
      category: 'model-routing', operation: 'explore-child', baseline: { model: parent, tokens },
      actual: { model: child, tokens, costUsd: cost },
      basis: { kind: 'estimated-baseline', method: 'parent-model-reprice-observed-child-usage-v1' },
      dimensions: { techniques: ['explore', 'same-usage-reprice'] },
    });
    expect(f.storageFactory).toHaveBeenCalledExactlyOnceWith('session');
    await f.shutdown();
  });

  it.each([
    ['same model', { model: { provider: 'TEST', id: 'PARENT' } }],
    ['non-explore', { label: 'general' }],
    ['empty result', { result: { text: ' \n ', truncated: false } }],
    ['failed', { state: 'failed' }],
    ['cancelled', { state: 'cancelled' }],
    ['queued', { state: 'queued' }],
    ['running', { state: 'running' }],
  ] satisfies Array<[string, Partial<SessionExecution>]>)('does not claim %s executions', async (_name, overrides) => {
    const f = fixture();
    await f.start();
    await recordParent(f);
    await f.observe([completed(overrides)]);
    expect(f.report).not.toHaveBeenCalled();
    await f.shutdown();
  });

  it('ignores missing child models, missing usage and zero-token deltas', async () => {
    const f = fixture();
    await f.start();
    await recordParent(f);
    const { model: _, usage: __, ...withoutModelOrUsage } = completed();
    await f.observe([withoutModelOrUsage]);
    await f.observe([{ ...withoutModelOrUsage, usage }]);
    await f.observe([completed({ usage: { ...usage, cost: 0.5 } })]);
    expect(f.report).not.toHaveBeenCalled();
    await f.shutdown();
  });

  it('advances failed intervals before a successful continuation', async () => {
    const f = fixture();
    await f.start();
    await recordParent(f);
    await f.observe([completed({ state: 'failed' })]);
    await f.observe([record()]);
    await f.observe([completed({ usage: { input: 11, output: 7, cacheRead: 5, cacheWrite: 7, cacheWrite1h: 6, cost: 0.5 } })]);
    expect(f.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      baseline: { model: parent, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 5 } },
      actual: { model: child, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 5 }, costUsd: expect.closeTo(0.1) },
    }));
    await f.shutdown();
  });

  it.each(['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'cost'] as const)(
    'advances a negative %s delta without claiming it', async key => {
      const f = fixture();
      await f.start();
      await recordParent(f);
      await f.observe([completed({ state: 'failed' })]);
      const reset = { ...usage, [key]: 0 };
      await f.observe([completed({ usage: reset })]);
      expect(f.report).not.toHaveBeenCalled();
      await f.observe([completed({ usage: { ...reset, output: reset.output + 1 } })]);
      expect(f.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        actual: { model: child, tokens: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } },
      }));
      await f.shutdown();
    },
  );

  it('never claims unrecorded parent models, including later continuations', async () => {
    const f = fixture({ initial: [completed()] });
    await f.start();
    await f.observe([record()]);
    await f.observe([completed({ usage: { ...usage, output: 10 } })]);
    expect(f.report).not.toHaveBeenCalled();
    expect(JSON.parse(new TextDecoder().decode(f.files.get(path))).entry.usage.output).toBe(10);
    await f.shutdown();
  });

  it('restores the original parent model for a child completed while the extension was absent', async () => {
    const first = fixture();
    await first.start();
    await recordParent(first);
    await first.shutdown();
    const next = fixture({ initial: [completed()], persistence: first });
    await next.start();
    expect(next.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ baseline: expect.objectContaining({ model: parent }) }));
    await next.shutdown();
  });

  it('restores terminal watermarks without replaying usage', async () => {
    const first = fixture();
    await first.start();
    await recordParent(first);
    await first.observe([completed()]);
    await first.shutdown();
    const next = fixture({ initial: [completed()], persistence: first });
    await next.start();
    expect(next.report).not.toHaveBeenCalled();
    await next.observe([completed({ usage: { ...usage, output: 7 } })]);
    expect(next.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      baseline: { model: parent, tokens: { input: 0, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } },
      actual: { model: child, tokens: { input: 0, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } },
    }));
    await next.shutdown();
  });

  it('paginates only direct children and keeps nested sessions separate in shared storage', async () => {
    const persistence = memoryStorage();
    const outer = fixture({ persistence, pageSize: 1 });
    const inner = fixture({ persistence, currentId: 'child' });
    await recordParent(outer);
    await recordParent(outer, 'sibling');
    await recordParent(inner, 'nested', child);
    await outer.start();
    await inner.start();
    const records = [completed(), completed({ id: 'sibling' }), completed({ id: 'nested', parent: 'child', model: parent })];
    await outer.observe(records);
    await inner.observe(records);
    expect(outer.report).toHaveBeenCalledTimes(2);
    expect(inner.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      baseline: expect.objectContaining({ model: child }), actual: expect.objectContaining({ model: parent }),
    }));
    expect(outer.sessions.executions).toHaveBeenCalledWith({ includeDescendants: false, cursor: '1' });
    expect(outer.sessions.executions.mock.calls.every(([query]) => query?.includeDescendants === false)).toBe(true);
    expect([...persistence.files.keys()].sort()).toEqual([
      'savings/explore-routing/child.json', 'savings/explore-routing/nested.json', 'savings/explore-routing/sibling.json',
    ]);
    await outer.shutdown();
    await inner.shutdown();
  });

  it.each(['not json', '{"version":2}', '{"version":1,"entry":{"executionId":"child","usage":{"input":-1}}}'])(
    'tolerates corrupt or unsupported storage: %s', async content => {
      const f = fixture();
      f.files.set(path, new TextEncoder().encode(content));
      await f.start();
      await recordParent(f);
      await f.observe([completed()]);
      expect(f.report).toHaveBeenCalledTimes(1);
      await f.shutdown();
    },
  );

  it('isolates storage, listing and reporter failures from listeners', async () => {
    const f = fixture();
    vi.mocked(f.storage.readFile).mockRejectedValue(new Error('unreadable'));
    vi.mocked(f.storage.writeFile).mockRejectedValue(new Error('unwritable'));
    f.sessions.executions.mockRejectedValueOnce(new Error('unavailable'));
    await expect(f.start()).resolves.toBeUndefined();
    await recordParent(f);
    f.report.mockRejectedValue(new Error('reporter unavailable'));
    expect(() => f.emit([completed()])).not.toThrow();
    await expect(f.tracker!.settle()).resolves.toBeUndefined();
    expect(f.report).toHaveBeenCalledTimes(1);
    await f.observe([completed()]);
    expect(f.report).toHaveBeenCalledTimes(1);
    await f.shutdown();
  });

  it('coalesces bursts of execution events into one pending reconcile', async () => {
    const f = fixture();
    await f.start();
    await recordParent(f);
    const before = f.sessions.executions.mock.calls.length;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    f.sessions.executions.mockImplementationOnce(async () => { await blocked; return { items: [] }; });
    f.emit([]);
    await vi.waitFor(() => expect(f.sessions.executions).toHaveBeenCalledTimes(before + 1));
    for (let index = 0; index < 5; index++) f.emit([completed()]);
    release();
    await f.tracker!.settle();
    expect(f.sessions.executions).toHaveBeenCalledTimes(before + 2);
    expect(f.report).toHaveBeenCalledOnce();
    await f.shutdown();
  });

  it('subscribes only when the session has explore children', async () => {
    const f = fixture();
    await f.start();
    await f.start();
    expect(f.sessions.executions).toHaveBeenCalledTimes(1);
    expect(f.sessions.subscribe).not.toHaveBeenCalled();
    await recordParent(f);
    expect(f.sessions.subscribe).toHaveBeenCalledTimes(1);
    f.emit([completed()], { kind: 'history', id: 'child' });
    await f.tracker!.settle();
    expect(f.sessions.executions).toHaveBeenCalledTimes(1);
    await f.shutdown();
  });

  it('drains reports before shutdown completes and unsubscribes immediately', async () => {
    const f = fixture();
    await f.start();
    await recordParent(f);
    let release!: () => void;
    f.report.mockImplementation(async () => new Promise<void>(resolve => { release = resolve; }));
    f.emit([completed()]);
    await vi.waitFor(() => expect(f.report).toHaveBeenCalledTimes(1));
    const disposed = vi.fn();
    const disposing = f.shutdown().then(disposed);
    expect(f.listeners.size).toBe(0);
    expect(disposed).not.toHaveBeenCalled();
    release();
    await disposing;
    f.emit([completed({ usage: { ...usage, input: 100 } })]);
    await f.tracker!.settle();
    expect(f.report).toHaveBeenCalledTimes(1);
  });

  it.each(['runtime', 'savings'] as const)('does nothing without pi.%s', property => {
    const f = fixture();
    const { [property]: _, ...pi } = f.pi;
    f.hooks.clear();
    expect(registerExploreRoutingSavings(pi as FelanExtensionAPI, f.sessions as unknown as SessionsService)).toBeUndefined();
    expect(f.hooks.size).toBe(0);
  });

  it('captures the spawn context model, not the routed model or a later parent model', async () => {
    const f = fixture({ integrated: true });
    await f.start();
    const context = { model: { ...parent } as ExtensionContext['model'] };
    f.sessions.create.mockImplementationOnce(async () => {
      context.model = { ...child } as ExtensionContext['model'];
      return record();
    });
    await spawn(f, context);
    expect(f.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ model: child }), undefined);
    expect(JSON.parse(new TextDecoder().decode(f.files.get(path))).entry.parentModel).toEqual(parent);
    f.emit([completed()]);
    await f.shutdown();
    expect(f.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ baseline: expect.objectContaining({ model: parent }) }));
  });

  it('records admission before queued events can watermark a fast completion', async () => {
    const f = fixture({ integrated: true });
    f.sessions.executions.mockResolvedValueOnce({ items: [completed({ id: 'earlier' })] });
    await f.start();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    f.sessions.executions.mockImplementationOnce(async () => { await blocked; return { items: [] }; });
    f.emit([]);
    await vi.waitFor(() => expect(f.sessions.executions).toHaveBeenCalledTimes(2));
    f.sessions.create.mockImplementationOnce(async () => {
      const execution = completed();
      f.emit([execution]);
      return execution;
    });
    const spawning = spawn(f);
    await Promise.resolve();
    release();
    await spawning;
    await f.shutdown();
    expect(f.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ baseline: expect.objectContaining({ model: parent }) }));
  });

  it.each(['non-explore', 'missing parent model', 'failed admission'])('does not record a parent for %s', async mode => {
    const f = fixture({ integrated: true });
    await f.start();
    if (mode === 'failed admission') f.sessions.create.mockRejectedValueOnce(new Error('denied'));
    await spawn(f, mode === 'missing parent model' ? {} : { model: parent as ExtensionContext['model'] }, mode === 'non-explore' ? 'general' : 'explore');
    expect(f.files.size).toBe(0);
    f.emit([completed()]);
    await f.shutdown();
    expect(f.report).not.toHaveBeenCalled();
  });
});
