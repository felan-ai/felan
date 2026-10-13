import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SessionClient, newRequestId } from '../../felan/src/client/client.js';
import { TestHostConfiguration as DaemonConfiguration } from './fixtures/host-services.js';
import { SessionServer } from '../src/daemon/server.js';
import { fixture, fixtures } from './fixtures/registry.js';

afterEach(async () => { for (const dispose of fixtures.splice(0).reverse()) await dispose(); });

it.each(['tui', 'acp'] as const)('recovers an unattached session through explicit local-console %s reload', async kind => {
  const f = await fixture({ now: Date.now });
  const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  const previous = f.store.configuration(binding.sessionId)!.identity;
  await f.registry.evictIdle();
  const resolve = f.profile.resolveResources.bind(f.profile);
  f.profile.resolveResources = async request => ({ ...await resolve(request), agentStorageRoot: join(f.owner.target.agentDir, 'new-agent-storage') });
  const server = new SessionServer({ registry: f.registry, version: 'fixture', models: { getAvailable: async () => [] },
    configuration: new DaemonConfiguration({ definitions: [], assertCurrent: () => f.registry.assertAdmission() }) });
  await server.start();
  const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId },
    expected: f.owner.identity, clientVersion: 'fixture', kind, retries: 0 });
  try {
    await client.connect();
    expect(await client.attach(binding.sessionId)).toMatchObject({ outcome: 'rejected', error: { code: 'configuration_recovery_required' } });
    const connection = [...Reflect.get(server, 'connections') as Set<object>][0]!;
    Object.defineProperty(connection, 'localConsole', { value: false, configurable: true });
    expect(await client.request('session.reload', {}, { session: binding.sessionId })).toMatchObject({ outcome: 'rejected', error: { code: 'forbidden' } });
    Object.defineProperty(connection, 'localConsole', { value: true, configurable: true });
    const reloadId = newRequestId();
    expect(await client.request('session.reload', {}, { session: binding.sessionId, id: reloadId })).toMatchObject({ outcome: 'accepted' });
    const remote = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId },
      expected: f.owner.identity, clientVersion: 'fixture', kind, retries: 0 });
    try {
      await remote.connect();
      const remoteConnection = [...Reflect.get(server, 'connections') as Set<object>].at(-1)!;
      Object.defineProperty(remoteConnection, 'localConsole', { value: false, configurable: true });
      expect(await remote.request('session.reload', {}, { session: binding.sessionId, id: reloadId })).toMatchObject({ outcome: 'rejected', error: { code: 'forbidden' } });
    } finally { remote.close(); }
    expect(await client.attach(binding.sessionId)).toMatchObject({ outcome: 'accepted', result: { snapshot: { session: binding.sessionId } } });
    expect(f.store.configuration(binding.sessionId)!.identity).not.toEqual(previous);
    expect(f.store.session(binding.sessionId).id).toBe(binding.sessionId);
  } finally { client.close(); server.close(); }
});
