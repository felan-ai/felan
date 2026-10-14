import { afterEach, expect, it, vi } from 'vitest';
import { gate } from '../../daemon/test/fixtures/server.js';
import { accepted, waitForDaemonRun } from '../src/acp/daemon-session.js';
import { acpDaemonFixture } from './acp-daemon-fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('waits for an ACP run across failed automatic reconnect attempts until the restarted daemon returns', async () => {
  const stream = gate();
  const f = await acpDaemonFixture({ onStream: () => stream.promise }); cleanups.push(() => f.dispose());
  cleanups.push(async () => stream.resolve());
  const client = f.createClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: 'unused' }, kind: 'acp', clientVersion: 'fixture', reconnectDelayMs: 20 });
  await client.connect(); accepted(await client.attach(f.root.sessionId));
  const statuses: string[] = []; client.subscribe(() => statuses.push(client.status));
  const { runId } = accepted(await client.request('prompt', { text: 'survive restart' }, { session: f.root.sessionId }));
  const finished = waitForDaemonRun(client, f.root.sessionId, runId);
  await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run.state).toBe('running'));
  f.server.close();
  await vi.waitFor(() => expect(client.reconnection?.attempt).toBeGreaterThanOrEqual(3));
  await f.restartServer();
  await vi.waitFor(() => expect(client.status).toBe('ready'));
  stream.resolve();
  expect((await finished).run.state).toBe('idle');
  expect(statuses.filter(status => status === 'connecting').length).toBeGreaterThanOrEqual(3);
  expect(statuses).not.toContain('blocked');
});
