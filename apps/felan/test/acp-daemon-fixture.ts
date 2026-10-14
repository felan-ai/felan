import { DAEMON_VERSION } from '@felan-ai/daemon';
import type { AgentContext, SessionNotification } from '@agentclientprotocol/sdk';
import { vi } from 'vitest';
import { SessionClient, type SessionClientOptions } from '../src/client/client.js';
import { resolveClientHostComposition } from '../src/daemon-entrypoint.js';
import { InteractionBroker } from '../../daemon/src/daemon/broker.js';
import { DaemonConfiguration } from '../src/providers/configuration.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';

export async function acpDaemonFixture(options: Parameters<typeof serverFixture>[0] = {}) {
  const fixture = await serverFixture({ now: Date.now, ...options });
  const target = { kind: 'isolated' as const, directory: fixture.directory, namespaceId: fixture.owner.target.namespaceId, storeRoots: [fixture.directory] };
  const composition = await resolveClientHostComposition(target);
  const broker = new InteractionBroker({ store: fixture.store, now: Date.now,
    resume: async (_session, _answer, _id, dispatch) => { dispatch(); },
    publish: (interaction, revisions) => fixture.registry.publishInteraction(interaction, revisions) });
  const configuration = new DaemonConfiguration({ agentDir: fixture.owner.target.agentDir, definitions: options.configDefinitions ?? [], assertCurrent: () => fixture.registry.assertAdmission() });
  const createServer = () => new SessionServer({ registry: fixture.registry, configuration, models: fixture.root.runtime.session.modelRuntime, version: DAEMON_VERSION, broker, composition });
  const server = createServer();
  const servers = [server];
  await server.start();
  const clients: SessionClient[] = [];
  const createClient = (options: SessionClientOptions) => {
    const { launch: _launch, ...rest } = options;
    // Reload invalidation can close the transport before its reply; retain the production retry policy.
    const client = new SessionClient({ ...rest, target, expectedComposition: {
      managerPackage: composition.managerPackage, managerVersion: composition.managerVersion, providerDigest: composition.providerDigest,
    }, expected: fixture.owner.identity,
      requestTimeoutMs: 1000 });
    clients.push(client);
    return client;
  };
  const updates: SessionNotification[] = [];
  const editor = { notify: vi.fn(async (_method, notification: SessionNotification) => { updates.push(notification); }),
    request: vi.fn(async () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } })) } as unknown as AgentContext;
  return { ...fixture, broker, server, clients, createClient, editor, updates,
    /** Serves the same daemon identity again after `server.close()`, as a restarted daemon would. */
    async restartServer() { const next = createServer(); servers.push(next); await next.start(); return next; },
    async dispose() {
      for (const client of clients) client.close();
      for (const item of servers) item.close();
      await broker.drain();
      await fixture.dispose();
    } };
}
