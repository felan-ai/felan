import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { bindFelanExtension, type AgentRuntime } from '@felan-ai/agent-core';
import { createInsightsExtension } from '@felan-ai/ext-insights';
import { INSIGHTS_REPORT_PRESENTER, parseInsightsReportRequest } from '@felan-ai/ext-insights/view';
import { createLocalInsightsHost } from '../../daemon/src/insights.js';
import { createRegistryInteractionBroker } from '../../daemon/src/daemon/broker.js';
import { createSessionExtensionUi, SESSION_UI_PRESENTERS } from '../../daemon/src/daemon/extension-ui.js';
import { DaemonConfiguration } from '../../daemon/src/daemon/configuration.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';
import { assistant } from '../../daemon/test/fixtures/registry.js';
import { SessionClient } from '../src/client/client.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

it('generates reports in the daemon, retains them on declined opening, and honors --no-open', async () => {
  let broker!: ReturnType<typeof createRegistryInteractionBroker>; let bridge!: ReturnType<typeof createSessionExtensionUi>;
  let runtime!: AgentRuntime; let agentDir = ''; let sessionDir = ''; const model = vi.fn();
  const f = await serverFixture({ now: () => Date.now(), onStream: async () => { model(); }, extensionUi(context, registry) {
    runtime = context.runtime; agentDir = context.resources.agentDir; sessionDir = context.sessionManager.getSessionDir();
    broker ??= createRegistryInteractionBroker(registry, { presenters: SESSION_UI_PRESENTERS });
    bridge = createSessionExtensionUi({ broker, scope: { kind: 'session', session: context.sessionManager.getSessionId(), root: context.rootSessionId } }); return bridge;
  }, extension(pi) {
    const host = createLocalInsightsHost(undefined, sessionDir, bridge.insights);
    const bound = bindFelanExtension('fixture-insights', createInsightsExtension(host), runtime, agentDir);
    return typeof bound === 'function' ? bound(pi) : bound.factory(pi);
  } });
  let client: SessionClient | undefined; let server: SessionServer | undefined;
  cleanups.push(async () => { client?.close(); server?.close(); bridge.dispose(); await broker.drain(); await f.dispose(); });
  f.root.runtime.session.sessionManager.appendMessage({ role: 'user', content: 'Private report fixture', timestamp: Date.now() });
  f.root.runtime.session.sessionManager.appendMessage(assistant('fixture response'));
  const configuration = new DaemonConfiguration({ agentDir, definitions: [], assertCurrent: () => f.registry.assertAdmission() });
  server = new SessionServer({ registry: f.registry, configuration, models: f.root.runtime.session.modelRuntime, version: 'fixture', broker });
  bridge.activate(update => f.registry.projection(f.root.sessionId).setPresentation(update)); await server.start();
  client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
    expected: f.owner.identity, clientVersion: 'fixture', kind: 'tui', presenters: [INSIGHTS_REPORT_PRESENTER], interactionKinds: ['custom'], requestTimeoutMs: 1000, retries: 0 });
  await client.connect(); await client.attach(f.root.sessionId);
  expect(await client.request('command.invoke', { name: 'insights', arguments: '' }, { session: f.root.sessionId })).toMatchObject({ outcome: 'accepted' });
  const pending = () => broker.pending().find(item => item.request.kind === 'custom' && item.request.presenter.id === INSIGHTS_REPORT_PRESENTER.id);
  await vi.waitFor(() => expect(pending()).toBeDefined()); const item = pending()!;
  expect(item.scope).toEqual({ kind: 'host' }); if (item.request.kind !== 'custom') throw new Error();
  const request = parseInsightsReportRequest(item.request.data);
  expect(request.path.startsWith(f.directory)).toBe(true); expect(await readFile(request.path, 'utf8')).toContain('<html');
  expect(await client.request('interaction.answer', { interactionId: item.id, answer: { kind: 'custom', presenter: INSIGHTS_REPORT_PRESENTER, data: { opened: false } } })).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run.state).toBe('idle'));
  expect(await readFile(request.path, 'utf8')).toContain('<html');
  expect(await client.request('command.invoke', { name: 'insights', arguments: '--no-open' }, { session: f.root.sessionId })).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run.state).toBe('idle'));
  expect(pending()).toBeUndefined(); expect(model).not.toHaveBeenCalled();
});
