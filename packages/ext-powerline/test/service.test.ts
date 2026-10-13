import {
  createExtensionServiceAccess, createFelanServiceRegistry, createSilentLogger, getExtensionConfigDefinition,
  MODELS_SERVICE, SESSIONS_SERVICE, USAGE_SERVICE,
  type AgentRuntimeStorage, type ExtensionContext, type ExtensionUi, type FelanExtensionAPI, type ModelsService, type SessionsService, type UiInteractiveElement,
} from '@felan-ai/agent-core';
import { afterEach, expect, it, vi } from 'vitest';
import extension, { POWERLINE_CONFIG } from '../src/extension.js';

afterEach(() => vi.useRealTimers());

function harness(mode: ExtensionContext['mode'] = 'rpc') {
  const services = createFelanServiceRegistry();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void | Promise<void>>();
  const exec = vi.fn(async () => ({ code: 0, killed: false, stdout: '', stderr: '' }));
  const views: UiInteractiveElement[] = [];
  const close = vi.fn(async () => {});
  const update = vi.fn(async (element: UiInteractiveElement) => { views.push(element); });
  const ui = {
    present: vi.fn<ExtensionUi['present']>().mockImplementation(async element => { views.push(element); return { update, close }; }),
    status: vi.fn<ExtensionUi['status']>().mockResolvedValue(undefined),
    removeStatus: vi.fn<ExtensionUi['removeStatus']>().mockResolvedValue(undefined),
  };
  const files = new Map<string, Uint8Array>();
  const storage = { readFile: vi.fn(async (path: string) => { if (!files.has(path)) throw new Error('ENOENT'); return files.get(path)!; }),
    writeFile: vi.fn(async (path: string, bytes: Uint8Array) => { files.set(path, bytes); }) } as unknown as AgentRuntimeStorage;
  const pi = { config: {}, exec, services: createExtensionServiceAccess(services, extension.serviceRequirements!), ui,
    runtime: { logger: createSilentLogger(), storage: () => storage }, on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>) => handlers.set(name, handler),
  } as unknown as FelanExtensionAPI;
  const ctx = { mode, cwd: '/fixture/界\u001b[31m', model: { id: 'claude-fixture', provider: 'anthropic', contextWindow: 8192 }, thinkingLevel: 'off',
    getContextUsage: () => ({ tokens: 10, percent: 1, contextWindow: 8192 }),
    sessionManager: { getEntries: () => [{ type: 'message', message: { role: 'assistant', usage: {
      input: 1234, output: 456, cacheRead: 78, cacheWrite: 9, cost: { total: 0.12345 },
    } } }] },
    modelRegistry: { getAvailable: () => [{ provider: 'anthropic' }] },
  } as unknown as ExtensionContext;
  return { services, handlers, pi, exec, ui, views, close, update, ctx, storage, files,
    emit: (name: string) => handlers.get(name)?.({}, ctx) };
}

it('declares optional core services and retains root configuration metadata', async () => {
  expect(getExtensionConfigDefinition(extension)).toBe(POWERLINE_CONFIG);
  expect(extension.serviceRequirements).toEqual({ optional: [MODELS_SERVICE, SESSIONS_SERVICE, USAGE_SERVICE] });
  const h = harness();
  await extension(h.pi);
  expect(h.handlers.has('session_start')).toBe(true);
  expect(h.exec).not.toHaveBeenCalled();
});

it.each(['rpc', 'print', 'tui'] as const)('publishes complete generic data in %s without a presentation or usage service', async mode => {
  const h = harness(mode);
  await extension(h.pi);
  try {
    await h.emit('session_start');
    await vi.waitFor(() => expect(h.ui.status).toHaveBeenCalledWith(expect.objectContaining({
      id: 'powerline-session-input', value: { kind: 'tokens', value: 1234 },
    })));
    expect(h.exec).toHaveBeenCalled();
    const view = h.views.at(-1)!;
    expect(view).toMatchObject({ kind: 'view', hint: { id: 'felan.powerline', version: '2.0.0' }, actions: [] });
    if (view.kind !== 'view') throw new Error('Expected a generic view');
    expect(view.items.some(item => item.values.segment === 'model' && item.values.text === 'claude-fixture')).toBe(true);
    expect(view.items.some(item => item.values.segment === 'directory' && String(item.values.text).includes('界'))).toBe(true);
    expect(view.items.some(item => item.values.segment === 'subscription' || item.values.segment === 'savings')).toBe(false);
    expect(JSON.stringify(view)).not.toContain('\u001b');
    expect(h.ui.status).toHaveBeenCalledWith(expect.objectContaining({ value: { kind: 'money', value: 0.12345, currency: 'USD' } }));
    expect(h.ui.status).toHaveBeenCalledWith(expect.objectContaining({ value: { kind: 'percent', value: 1 } }));
  } finally { await h.emit('session_shutdown'); }
  expect(h.close).toHaveBeenCalledOnce();
  expect(h.ui.removeStatus).toHaveBeenCalledWith('powerline-session-input');
});

it('uses optional usage in an ACP-like session and cancels outstanding queries on shutdown', async () => {
  const h = harness();
  const getSubscriptionUsage = vi.fn(async () => ({ ok: true as const, data: {} }));
  let querySignal: AbortSignal | undefined;
  let finish!: () => void;
  const query = vi.fn(async (request: { signal?: AbortSignal }) => {
    querySignal = request.signal;
    await new Promise<void>(resolve => { finish = resolve; });
    return { savedCostUsd: 1, hasUnpricedMeasurements: false };
  });
  const unsubscribeUsage = vi.fn();
  h.services.set(MODELS_SERVICE, { getSubscriptionUsage } as unknown as ModelsService);
  h.services.set(USAGE_SERVICE, { querySavings: query });
  const executions = vi.fn(async () => ({ items: [] }));
  h.services.set(SESSIONS_SERVICE, { current: { id: 'root', root: 'root' }, executions, subscribe: () => unsubscribeUsage } as unknown as SessionsService);
  await extension(h.pi);
  await h.emit('session_start');
  await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(getSubscriptionUsage).toHaveBeenCalledOnce());
  expect(executions).toHaveBeenCalled();
  let settled = false;
  const shutdown = Promise.resolve(h.emit('session_shutdown')).then(() => { settled = true; });
  expect(querySignal?.aborted).toBe(true);
  expect(settled).toBe(false);
  finish();
  await shutdown;
  expect(unsubscribeUsage).toHaveBeenCalledOnce();
});

it('publishes subscription, savings, version and paginated child usage from core services', async () => {
  const h = harness();
  Object.assign(h.pi, { config: { lines: [{ segments: {
    subscription: { enabled: true }, savings: { enabled: true }, session: { enabled: true }, version: { enabled: true },
  } }] } });
  Object.assign(h.pi.runtime, { host: { name: 'Felan', version: '1.2.3' } });
  h.services.set(MODELS_SERVICE, { getSubscriptionUsage: vi.fn(async () => ({ ok: true, data: {
    five_hour: { utilization: 25 }, seven_day: { utilization: 50 },
  } })) } as unknown as ModelsService);
  h.services.set(USAGE_SERVICE, { querySavings: vi.fn(async () => ({ savedCostUsd: 1.25, hasUnpricedMeasurements: false })) });
  let notify!: (event: { kind: 'execution' | 'history'; id: string }) => void;
  const executions = vi.fn(async (options?: { cursor?: string }) => ({
    items: [{ id: options?.cursor ? 'grandchild' : 'child', state: 'completed', usage: {
      input: options?.cursor ? 20 : 10, output: 1, cacheRead: 2, cacheWrite: 3, cost: 0.5,
    } }], ...(options?.cursor ? {} : { nextCursor: 'next' }),
  }));
  const history = vi.fn();
  h.services.set(SESSIONS_SERVICE, { current: { id: 'root', root: 'root' }, executions, history,
    subscribe: (listener: typeof notify) => { notify = listener; return () => {}; },
  } as unknown as SessionsService);
  await extension(h.pi);
  try {
    await h.emit('session_start');
    await vi.waitFor(() => expect(h.ui.status).toHaveBeenCalledWith(expect.objectContaining({
      id: 'powerline-session-input', value: { kind: 'tokens', value: 1264 },
    })));
    const rendered = JSON.stringify(h.views.at(-1));
    expect(rendered).toContain('subscription');
    expect(rendered).toContain('25%');
    expect(rendered).toContain('savings');
    expect(rendered).toContain('1.25');
    expect(rendered).toContain('1.2.3');
    expect(executions).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'next', includeDescendants: true }));
    notify({ kind: 'history', id: 'child' });
    expect(executions).toHaveBeenCalledTimes(2);
    notify({ kind: 'execution', id: 'child' });
    await vi.waitFor(() => expect(executions).toHaveBeenCalledTimes(4));
    expect(history).not.toHaveBeenCalled();
  } finally { await h.emit('session_shutdown'); }
  expect(h.storage.readFile).not.toHaveBeenCalled();
  expect(h.storage.writeFile).not.toHaveBeenCalled();
});

it('stops polling after a failed publish, closes owned data, and surfaces a sanitized failure', async () => {
  vi.useFakeTimers();
  const h = harness();
  h.ui.status.mockRejectedValueOnce(new Error('private provider credential'));
  await extension(h.pi);
  await h.emit('session_start');
  await vi.advanceTimersByTimeAsync(0);
  const probes = h.exec.mock.calls.length;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.exec).toHaveBeenCalledTimes(probes);
  expect(h.close).toHaveBeenCalledOnce();
  const shutdown = Promise.resolve(h.emit('session_shutdown'));
  await expect(shutdown).rejects.toThrow('Powerline');
  await expect(shutdown).rejects.not.toThrow('private provider credential');
  expect(vi.getTimerCount()).toBe(0);
});
