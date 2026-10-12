import { afterEach, expect, it, vi } from 'vitest';
import { bindFelanExtension, type AgentRuntime } from '@felan-ai/agent-core';
import { POWERLINE_PRESENTER, parsePowerlineData } from '@felan-ai/ext-powerline/view';
import { createRegistryInteractionBroker } from '../../daemon/src/daemon/broker.js';
import { createSessionExtensionUi, SESSION_UI_PRESENTERS } from '../../daemon/src/daemon/extension-ui.js';
import { DaemonConfiguration } from '../../daemon/src/daemon/configuration.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';
import { SessionClient } from '../src/client/client.js';
import { createClientPowerlineFooter } from '../src/client/powerline-presenter.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

it('keeps daemon powerline work scoped to compatible TUI attachments and restores it after reconnect', async () => {
  let broker!: ReturnType<typeof createRegistryInteractionBroker>; let bridge!: ReturnType<typeof createSessionExtensionUi>;
  let runtime!: AgentRuntime; let agentDir = ''; const exec = vi.fn(async (_command: string, args: string[]) => ({ code: 0, killed: false, stderr: '',
    stdout: args.includes('--show-toplevel') ? '/fixture' : args.includes('--porcelain=v2') ? '# branch.head main\n' : '' }));
  const f = await serverFixture({ now: () => Date.now(), extensionUi(context, registry) {
    runtime = context.runtime; agentDir = context.resources.agentDir;
    broker ??= createRegistryInteractionBroker(registry, { presenters: SESSION_UI_PRESENTERS });
    bridge = createSessionExtensionUi({ broker, scope: { kind: 'session', session: context.sessionManager.getSessionId(), root: context.rootSessionId } }); return bridge;
  }, extension(pi) {
    const testRuntime = new Proxy(runtime, { get(target, property) { return property === 'exec' ? exec : Reflect.get(target, property, target); } });
    const bound = bindFelanExtension('fixture-powerline', felan => {
      bridge.powerline({ fetchUsage: async () => ({ ok: true, data: {} }) }, {})(felan);
    }, testRuntime, agentDir);
    return typeof bound === 'function' ? bound(pi) : bound.factory(pi);
  } });
  const clients: SessionClient[] = []; let server: SessionServer | undefined; let footer: ReturnType<typeof createClientPowerlineFooter> | undefined;
  cleanups.push(async () => { footer?.dispose(); clients.forEach(client => client.close()); server?.close(); bridge.dispose(); await broker.drain(); await f.dispose(); });
  server = new SessionServer({ registry: f.registry, configuration: new DaemonConfiguration({ agentDir, definitions: [], assertCurrent: () => f.registry.assertAdmission() }),
    models: f.root.runtime.session.modelRuntime, version: 'fixture', broker });
  bridge.activate(update => f.registry.projection(f.root.sessionId).setPresentation(update)); await server.start();
  async function attach(kind: 'tui' | 'headless', version: string = POWERLINE_PRESENTER.version) {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      expected: f.owner.identity, clientVersion: 'fixture', kind, presenters: [{ ...POWERLINE_PRESENTER, version }], interactionKinds: ['custom'], retries: 0 });
    clients.push(client); await client.connect(); await client.attach(f.root.sessionId); return client;
  }
  await attach('headless'); await attach('tui', '0.0.0'); expect(exec).not.toHaveBeenCalled();
  const first = await attach('tui'); const second = await attach('tui');
  await vi.waitFor(() => expect(exec).toHaveBeenCalled());
  const view = (client: SessionClient) => client.getAttachment(f.root.sessionId)?.state.snapshot?.presentation.find(item => item.id === POWERLINE_PRESENTER.id);
  await vi.waitFor(() => expect(view(first)).toBeDefined());
  bridge.context.setStatus('fixture', 'Live status');
  await vi.waitFor(() => expect(JSON.stringify(view(first))).toContain('Live status'));
  footer = createClientPowerlineFooter(first, f.root.sessionId, {
    theme: () => ({ getFgAnsi: () => '', getBgAnsi: () => '' }), requestRender: vi.fn(), extraRows: () => ['child rail'],
  });
  expect(footer.render(100).join('\n')).toContain('Live status'); expect(footer.render(100).at(-1)).toBe('child rail');
  first.close(); await vi.waitFor(() => expect(view(second)).toBeDefined());
  second.close(); await vi.waitFor(() => expect(f.registry.projection(f.root.sessionId).snapshot().presentation.some(item => item.id === POWERLINE_PRESENTER.id)).toBe(false));
  const resumed = await attach('tui'); await vi.waitFor(() => expect(view(resumed)).toBeDefined());
  const value = view(resumed)!; if (value.kind !== 'custom') throw new Error('Expected powerline data');
  expect(parsePowerlineData(value.data).lines.flat().some(segment => segment.text === 'Live status')).toBe(true);
});
