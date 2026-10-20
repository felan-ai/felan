import { afterEach, expect, it, vi } from 'vitest';
import type { ExtensionUi, FelanExtension } from '@felan-ai/agent-core';
import type { UiForm } from '@felan-ai/session-protocol';
import { createRegistryInteractionBroker, type InteractionBroker } from '../src/daemon/broker.js';
import { createDaemonExecutionServices } from '../src/daemon/execution-services.js';
import type { SessionRuntime } from '../src/daemon/session-runtime.js';
import { serverFixture } from './fixtures/server.js';
import { createTestSessionRuntime } from './fixtures/session-runtime.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const form: UiForm = { title: 'Approval', fallback: 'Approve or cancel.', input: { fields: [] },
  actions: [{ id: 'approve', label: 'Approve', target: 'element', outcome: 'submit' }] };

it.each([undefined, 'session', 'owner', 'host'] as const)('routes Core audience %s through the generic daemon binding', async audience => {
  let broker!: InteractionBroker;
  let composition!: SessionRuntime;
  let ui!: ExtensionUi;
  const extension: FelanExtension = pi => { ui = pi.ui; };
  const f = await serverFixture({ deferActivation: true, extensionPackages: ['@test/authority-routing'],
    createComposition(runtimeFactory) {
      composition = createTestSessionRuntime({ runtimeFactory, importExtension: async () => ({ default: extension }) });
      return composition;
    },
    servicesFactory(registry) {
      broker = createRegistryInteractionBroker(registry);
      return createDaemonExecutionServices(registry, broker, composition);
    },
  });
  cleanups.push(async () => { await broker.drain(); await f.dispose(); });
  expect(ui).toBeDefined();
  broker.connected({ attachment: 'local-client', principal: `local:${f.owner.target.uid}:${f.owner.target.namespaceId}`, kind: 'acp', localConsole: true,
    sessions: [f.root.sessionId], interactionKinds: ['form'] });
  const controller = new AbortController();
  const answer = ui.request(form, { signal: controller.signal, ...(audience === undefined ? {} : { audience }) });
  await vi.waitFor(() => expect(broker.pending()).toHaveLength(1));
  const pending = broker.pending()[0]!;
  expect(pending.scope).toEqual(audience === 'host' ? { kind: 'host' }
    : { kind: 'session', session: f.root.sessionId, root: f.root.rootSessionId });
  expect(pending.authority).toBe(audience === 'owner' ? 'owner' : audience === 'host' ? 'local-console' : undefined);
  controller.abort();
  await expect(answer).resolves.toEqual({ state: 'cancelled', reason: 'abort' });
});
