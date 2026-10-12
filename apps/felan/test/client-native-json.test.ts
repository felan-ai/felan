import { afterEach, expect, it, vi } from 'vitest';
import { HEADLESS_JSON_PRESENTER } from '@felan-ai/session-protocol';
import { SessionClient } from '../src/client/client.js';
import { DaemonConfiguration } from '../../daemon/src/daemon/configuration.js';
import { headlessJsonEvent } from '../../daemon/src/daemon/headless-json.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it('streams the authoritative native header and print-mode events only to negotiated headless consumers', async () => {
  const f = await serverFixture({ now: Date.now });
  const server = new SessionServer({ registry: f.registry, models: f.root.runtime.session.modelRuntime, version: 'fixture',
    configuration: new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.owner.assertCurrent() }) });
  const clients: SessionClient[] = []; const releases: Array<() => void> = [];
  cleanup.push(async () => { releases.forEach(release => release()); clients.forEach(client => client.close()); server.close(); await server.settleCommands(); await f.dispose(); });
  await server.start();
  const connect = async (native: boolean) => {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      kind: 'headless', clientVersion: 'fixture', presenters: native ? [HEADLESS_JSON_PRESENTER] : [], reconnectAttempts: 0 });
    clients.push(client); await client.connect(); return client;
  };
  const client = await connect(true); const other = await connect(false);
  const actual: unknown[] = []; const suppressed: unknown[] = [];
  releases.push(client.subscribePresentation(event => actual.push(event.presentationEvent.data)), other.subscribePresentation(event => suppressed.push(event)));
  await client.attach(f.root.sessionId); await other.attach(f.root.sessionId);
  const expected: unknown[] = [JSON.parse(JSON.stringify(f.root.runtime.session.sessionManager.getHeader()))];
  releases.push(f.root.runtime.session.subscribe(event => expected.push(JSON.parse(JSON.stringify(headlessJsonEvent(event))))));
  expect(await client.request('prompt', { text: 'native JSON' }, { session: f.root.sessionId })).toMatchObject({ outcome: 'accepted' });
  await f.root.runtime.session.waitForIdle();
  await vi.waitFor(() => expect(actual).toEqual(expected));
  expect(actual.length).toBeGreaterThan(2); expect(suppressed).toEqual([]);
  expect(actual[0]).toMatchObject({ type: 'session', id: f.root.sessionId });
});

