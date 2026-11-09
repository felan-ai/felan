import { bindFelanExtension, type UiActionRequest } from '@felan-ai/agent-core';
import { afterEach, expect, it } from 'vitest';
import { createRegistryInteractionBroker, type InteractionBroker } from '../src/daemon/broker.js';
import { createDaemonExecutionServices } from '../src/daemon/execution-services.js';
import type { SessionExtensionContext } from '../src/daemon/provider.js';
import type { SessionRuntime } from '../src/daemon/session-runtime.js';
import { serverFixture } from './fixtures/server.js';
import { createTestSessionRuntime } from './fixtures/session-runtime.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('lets provider-bound Felan extensions present generic UI and receive its actions', async () => {
  const contexts: SessionExtensionContext[] = [];
  const actions: UiActionRequest[] = [];
  const composition: SessionRuntime = {
    ...createTestSessionRuntime(),
    async bindExtensions(context) {
      contexts.push(context);
      const report = bindFelanExtension('provider-report', pi => {
        pi.registerCommand('report', { handler: async () => {
          await pi.ui.present({ id: 'report', kind: 'document', revision: 1, title: 'Provider report', markdown: 'Provider-owned data', fallback: 'Report',
            actions: [{ id: 'refresh', label: 'Refresh', target: 'element', outcome: 'submit' }] }, { onAction: async action => { actions.push(action); } });
        } });
      }, context.runtime, context.resources.agentDir, {}, undefined, context.services, {}, context.createExtensionUi);
      return { importExtension: context.importExtension, inlineExtensions: [report], async dispose() {} };
    },
  };
  let broker!: InteractionBroker;
  const f = await serverFixture({ deferActivation: true, composition, servicesFactory: registry => {
    broker = createRegistryInteractionBroker(registry, {});
    return createDaemonExecutionServices(registry, broker, composition);
  } });
  cleanups.push(async () => { await broker.drain(); await f.dispose(); });
  expect(contexts[0]?.createExtensionUi).toBeTypeOf('function');

  await f.root.runtime.session.prompt('/report');
  const document = f.registry.projection(f.root.sessionId).snapshot().presentation.find(item => item.kind === 'document');
  expect(document).toMatchObject({ title: 'Provider report', markdown: 'Provider-owned data' });

  await f.registry.prepareUiAction(f.root.sessionId, { elementId: document!.id, revision: 1, actionId: 'refresh', outcome: 'submit', values: {} })(
    { requestId: 'provider-report-refresh', signal: new AbortController().signal });
  expect(actions).toEqual([{ elementId: 'report', revision: 1, actionId: 'refresh', outcome: 'submit', values: {} }]);
});
