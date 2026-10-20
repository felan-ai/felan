import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { parseClientEnvelope, parseRemoteCommandOutcome, type InteractionAuthority } from '@felan-ai/session-protocol';
import { OrderedAdmission } from '../src/daemon/admission.js';
import { createRegistryInteractionBroker } from '../src/daemon/broker.js';
import { SessionServer } from '../src/daemon/server.js';
import { TestHostConfiguration } from './fixtures/host-services.js';
import { serverFixture } from './fixtures/server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function id() { const time = Date.now().toString(16).padStart(12, '0'); return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(1, 4)}-8${randomUUID().slice(1, 4)}-${randomUUID().slice(-12)}`; }
async function fixture() {
  const f = await serverFixture({ now: Date.now }); const broker = createRegistryInteractionBroker(f.registry);
  const server = new SessionServer({ registry: f.registry, broker, models: f.root.runtime.session.modelRuntime, version: 'test',
    configuration: new TestHostConfiguration({ definitions: [], assertCurrent: () => f.registry.assertAdmission() }) });
  cleanups.push(async () => { await broker.drain(); server.close(); await f.dispose(); });
  function request(interactionId: string, answer: unknown = { kind: 'confirm', confirmed: true }) {
    return parseClientEnvelope({ v: 1, id: id(), op: 'interaction.answer', session: f.root.sessionId, params: { interactionId, answer } });
  }
  const remote = { user: randomUUID(), command: id(), interactionKinds: ['confirm'] as ['confirm'] };
  return { ...f, broker, server, request, remote };
}

it('refuses remote local-console answers while preserving local attached-client answers', async () => {
  const f = await fixture();
  const waiting = f.broker.request({ kind: 'confirm', title: 'Local', message: 'Approve locally' }, { kind: 'session', session: f.root.sessionId, root: f.root.sessionId }, { authority: 'local-console' });
  const interaction = f.broker.pending()[0]!;
  expect(await f.server.submitRemote(f.request(interaction.id), f.remote)).toMatchObject({ outcome: 'rejected', error: { code: 'forbidden' } });
  f.broker.connected({ principal: f.server.principal, kind: 'acp', attachment: 'local', sessions: [f.root.sessionId], interactionKinds: ['confirm'] });
  const admission = new OrderedAdmission(f.store);
  expect(await admission.submit(f.request(interaction.id), f.server.principal, command => f.broker.dispatch(command, {
    principal: f.server.principal, kind: 'acp', attachment: 'local', interactionKinds: ['confirm'],
  }))).toMatchObject({ outcome: 'accepted' });
  expect(await waiting).toEqual({ state: 'answered', answer: { kind: 'confirm', confirmed: true } });
});

it.each([undefined, 'owner'] satisfies (InteractionAuthority | undefined)[])('allows session authority %s; the first valid answer wins', async authority => {
  const f = await fixture();
  const waiting = f.broker.request({ kind: 'confirm', title: 'Session', message: 'Approve?' }, { kind: 'session', session: f.root.sessionId, root: f.root.sessionId }, authority ? { authority } : {});
  const interaction = f.broker.pending()[0]!;
  expect(await f.server.submitRemote(f.request(interaction.id, { kind: 'input', text: 'Wrong kind' }), f.remote)).toMatchObject({ outcome: 'rejected', error: { code: 'invalid_request' } });
  const first = await f.server.submitRemote(f.request(interaction.id), f.remote);
  expect(first).toMatchObject({ outcome: 'accepted' }); expect(parseRemoteCommandOutcome(first).outcome).toBe('accepted');
  expect(await waiting).toMatchObject({ state: 'answered' });
  expect(f.store.snapshot().interactions.find(row => row.id === interaction.id)).toMatchObject({ state: 'answered', responder: f.remote.command });
  expect(await f.server.submitRemote(f.request(interaction.id), f.remote)).toMatchObject({ outcome: 'rejected', error: { code: 'already_resolved' } });
});

it('refuses host-scoped interactions and kinds absent from advertised remote capabilities', async () => {
  const f = await fixture();
  void f.broker.request({ kind: 'confirm', title: 'Host', message: 'Machine decision' }, { kind: 'host' }, { authority: 'owner' });
  const host = f.broker.pending()[0]!;
  expect(await f.server.submitRemote(f.request(host.id), f.remote)).toMatchObject({ error: { code: 'forbidden' } });
  void f.broker.request({ kind: 'confirm', title: 'Session', message: 'Session decision' }, { kind: 'session', session: f.root.sessionId, root: f.root.sessionId });
  const session = f.broker.pending().find(row => row.scope.kind === 'session')!;
  expect(await f.server.submitRemote(f.request(session.id), { ...f.remote, interactionKinds: [] })).toMatchObject({ error: { code: 'forbidden' } });
});
