import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, createSilentLogger, type ExtensionContext, type FelanExtensionAPI, type LogRecord, type ModelRuntime } from '@felan-ai/agent-core';
import { createSessionTitleExtension, type SessionTitlePreparationRequest } from '@felan-ai/ext-session-title';
import { createDaemonSessionTitleHost, createLocalSessionTitleHost } from '../src/session-title.js';
import { ControlStoreError, type ControlSession } from '../src/daemon/control-state.js';
import { assistant, fixture, fixtures, offlineModel, requestId, supported } from './fixtures/registry.js';

afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });
const request = (): SessionTitlePreparationRequest => ({ sessionId: 'root', prompt: 'Summarize this session', mode: 'rpc', currentModel: offlineModel,
  parentSession: undefined, signal: new AbortController().signal });
function models() {
  const getAvailable = vi.fn(async () => [offlineModel]); const completeSimple = vi.fn(async () => assistant('Review auth boundaries'));
  return { getAvailable, completeSimple, runtime: { getAvailable, completeSimple } as unknown as ModelRuntime };
}

it('uses admitted TUI root origins, not the daemon RPC mode or a connected client', async () => {
  const model = models();
  const run = { state: 'running' as const, id: 'run', origin: { kind: 'tui' as const, attachment: 'client' } };
  let session = { id: 'root', root: 'root', state: 'open', run } as ControlSession;
  const host = createDaemonSessionTitleHost(model.runtime, { logger: createSilentLogger() }, { session: () => session });
  expect(await host.prepare(request())).toMatchObject({ prompt: request().prompt, models: [offlineModel] });
  for (const origin of [{ kind: 'acp', attachment: 'client' }, { kind: 'headless', attachment: 'client' }, { kind: 'automation', source: 'auto' }] as const) {
    session = { ...session, run: { ...run, origin } };
    expect(await host.prepare(request())).toBeUndefined();
  }
  session = { ...session, run: { state: 'idle' } }; expect(await host.prepare(request())).toBeUndefined();
  session = { ...session, run, parent: 'parent' }; expect(await host.prepare(request())).toBeUndefined();
  session = { ...session, parent: undefined, state: 'closed' } as ControlSession; expect(await host.prepare(request())).toBeUndefined();
  expect(model.getAvailable).toHaveBeenCalledTimes(1);
});

it('keeps legacy mode and child restrictions and aborts a pending model lookup', async () => {
  const model = models(); const host = createLocalSessionTitleHost(model.runtime, createSilentLogger());
  expect(await host.prepare(request())).toBeUndefined();
  expect(await host.prepare({ ...request(), mode: 'tui', parentSession: 'parent' })).toBeUndefined();
  expect(await host.prepare({ ...request(), mode: 'tui' })).toBeDefined();
  let release!: () => void; model.getAvailable.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return [offlineModel]; });
  const controller = new AbortController(); const pending = host.prepare({ ...request(), mode: 'tui', signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); controller.abort(); release(); await rejected;
});

it('does not suppress ownership errors or write private response details in diagnostics', async () => {
  const records: LogRecord[] = []; const logger = createLogger({ level: 'debug', destination: { write(record) { records.push(record); } } });
  const failure = new ControlStoreError('ownership_lost', 'owner changed');
  const host = createDaemonSessionTitleHost(models().runtime, { logger }, { session() { throw failure; } });
  await expect(host.prepare(request())).rejects.toBe(failure);
  await host.reportError?.({ sessionId: 'root', stage: 'complete', error: new Error('private-token') });
  await host.reportSkip?.({ sessionId: 'root', reason: 'empty-title', detail: 'private-prompt' });
  expect(records).toHaveLength(2); expect(JSON.stringify(records)).not.toContain('private');
  expect(records[0]?.fields).toMatchObject({ component: 'session-title', stage: 'complete', sessionId: 'root' });
});

describe.skipIf(!supported)('daemon title projection', () => {
  it('generates from an admitted TUI run and publishes the resulting session metadata', async () => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    f.store.updateSession(binding.sessionId, { run: { state: 'running', id: requestId(), origin: { kind: 'tui', attachment: 'client' } } });
    const model = models(); const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void | Promise<void>>();
    const manager = binding.runtime.session.sessionManager;
    createSessionTitleExtension(createDaemonSessionTitleHost(model.runtime, { logger: createSilentLogger() }, f.store))({
      on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>) => handlers.set(event, handler),
      getSessionName: () => manager.getSessionName(), setSessionName: (name: string) => {
        manager.appendSessionInfo(name); f.instances.get(binding.sessionId)!.emit({ type: 'session_info_changed', name });
      },
    } as unknown as FelanExtensionAPI);
    const ctx = { sessionManager: manager, model: offlineModel, mode: 'rpc' } as ExtensionContext;
    try {
      handlers.get('before_agent_start')!({ prompt: 'Review auth boundaries' }, ctx);
      await vi.waitFor(() => expect(manager.getSessionName()).toBe('Review auth boundaries'));
      f.registry.projection(binding.sessionId).refresh();
      expect(f.registry.projection(binding.sessionId).snapshot().title).toBe('Review auth boundaries');
      handlers.get('before_agent_start')!({ prompt: 'Later prompt' }, ctx); expect(model.completeSimple).toHaveBeenCalledTimes(1);
    } finally { await handlers.get('session_shutdown')!({ reason: 'shutdown' }, ctx); }
  });
});
