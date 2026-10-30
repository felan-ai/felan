import { afterEach, expect, it, vi } from 'vitest';
import type { RemoteStatus } from '@felan-ai/session-protocol';
import { identityFor } from '../../daemon/src/daemon/target.js';
import { SessionClient, newRequestId } from '../src/client/client.js';
import type { ClientDiagnostic } from '../src/client/diagnostics.js';
import { FakeTransport } from './client-fixtures.js';

const clients: SessionClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); vi.restoreAllMocks(); });
const token = 'fln_pat_synthetic_private_token';
const status: RemoteStatus = { configured: true, share: 'on-request', state: 'connected', apiUrl: 'https://app.felan.ai', projects: [], pending: 0, sessions: 0 };

async function fixture() {
  const diagnostics: ClientDiagnostic[] = [];
  const fake = new FakeTransport();
  const client = new SessionClient({ target: { kind: 'isolated', directory: '/unused', namespaceId: 'remote-test' },
    kind: 'tui', clientVersion: 'fixture', connector: fake.connector, reconnectAttempts: 0, diagnostics: event => diagnostics.push(event) });
  clients.push(client);
  const identity = identityFor(client.target, 'instance');
  fake.onSend = (request, connection) => {
    if (request.op === 'hello') fake.reply(request, { attachmentId: 'client', principal: 'principal', daemonVersion: 'fixture', protocol: 1,
      identity, operations: ['remote.status', 'remote.configure', 'session.remote'], interactionKinds: [] }, connection);
  };
  await client.connect();
  const retained = () => JSON.stringify([...(Reflect.get(client, 'records') as Map<string, unknown>).values()]);
  return { client, fake, diagnostics, retained };
}

const login = { action: 'login' } as const;

it('keeps a login request identity stable and rejects a conflicting retry under the same id', async () => {
  const f = await fixture(); const id = newRequestId();
  const response = f.client.request('remote.configure', login, { id });
  expect(f.client.request('remote.configure', login, { id })).toBe(response);
  expect(await f.client.request('remote.configure', { action: 'login', apiUrl: 'https://other.example.test' }, { id })).toMatchObject({ outcome: 'rejected', error: { code: 'request_conflict' } });
  await vi.waitFor(() => expect(f.fake.requests.filter(request => request.op === 'remote.configure')).toHaveLength(1));
  expect(f.fake.requests.at(-1)).toMatchObject({ op: 'remote.configure', params: login });
  expect(f.client.getRequest(id)).toMatchObject({ status: 'pending', attempts: 1 });
  f.fake.reply(f.fake.requests.at(-1)!, status);
  expect(await response).toMatchObject({ outcome: 'accepted', result: status });
  expect(f.client.getRequest(id)).toMatchObject({ status: 'accepted', attempts: 1 });
});

it('never replays a login after the connection is lost', async () => {
  const f = await fixture(); const response = f.client.request('remote.configure', login);
  await vi.waitFor(() => expect(f.fake.requests.filter(request => request.op === 'remote.configure')).toHaveLength(1));
  f.fake.lose();
  expect(await response).toMatchObject({ outcome: 'indeterminate', error: { message: 'Remote login reply was lost. Check /remote status or run /remote login again.' } });
  await f.client.connect();
  expect(f.fake.requests.filter(request => request.op === 'remote.configure')).toHaveLength(1);
});

it.each(['rejected', 'indeterminate'] as const)('redacts an accidentally echoed PAT from a %s login reply', async outcome => {
  const f = await fixture(); const id = newRequestId();
  const response = f.client.request('remote.configure', login, { id });
  f.fake.frame({ v: 1, re: id, outcome, error: { code: 'invalid_pat', message: `Rejected ${token}`, retryable: false } });
  expect(await response).toMatchObject({ outcome, error: { message: 'Rejected [redacted]' } });
  expect(f.retained()).not.toContain(token); expect(JSON.stringify(f.client.getRequest(id))).not.toContain(token);
});

it('redacts an accidentally echoed PAT from accepted remote status before returning or retaining it', async () => {
  const f = await fixture(); const id = newRequestId();
  const response = f.client.request('remote.configure', login, { id });
  f.fake.frame({ v: 1, re: id, outcome: 'accepted', result: { ...status, message: `Rejected ${token}` } });
  expect(await response).toMatchObject({ outcome: 'accepted', result: { message: 'Rejected [redacted]' } });
  expect(f.retained()).not.toContain(token);
});

it('reports a generic failure when transport delivery throws', async () => {
  const f = await fixture();
  const transport = Reflect.get(f.client, 'transport') as { send(value: unknown): void };
  vi.spyOn(transport, 'send').mockImplementationOnce(() => { throw new Error(`Failed to send ${token}`); });
  expect(await f.client.request('remote.configure', login)).toMatchObject({ outcome: 'indeterminate', error: { message: 'Request could not be delivered' } });
  expect(JSON.stringify(f.diagnostics)).not.toContain(token);
});

it('does not send a login rejected before transmission', async () => {
  const f = await fixture(); f.client.close();
  expect(await f.client.request('remote.configure', login)).toMatchObject({ outcome: 'rejected', error: { code: 'unavailable' } });
  expect(f.fake.requests.filter(request => request.op === 'remote.configure')).toHaveLength(0);
});
