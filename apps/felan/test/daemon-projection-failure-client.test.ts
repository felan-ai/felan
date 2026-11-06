import { afterEach, expect, it, vi } from 'vitest';
import { gate } from '../../daemon/test/fixtures/server.js';
import { accepted, waitForDaemonRun } from '../src/acp/daemon-session.js';
import { acpDaemonFixture } from './acp-daemon-fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it.each([false, true])('recovers an attached session after projection failure, including a missed revision (%s)', async missedRevision => {
  const stream = gate(); const started = gate();
  const f = await acpDaemonFixture({ onStream: async () => { started.resolve(); await stream.promise; } });
  cleanups.push(() => f.dispose()); cleanups.push(async () => stream.resolve());
  const id = f.root.sessionId;
  const other = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, model: f.root.runtime.session.model! });
  const clientDiagnostic = vi.fn();
  const client = f.createClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: 'unused' }, kind: 'headless', clientVersion: 'fixture', diagnostics: clientDiagnostic });
  await client.connect(); accepted(await client.attach(id)); accepted(await client.attach(other.sessionId));
  const { runId } = accepted(await client.request('prompt', { text: 'fail projection, not the daemon' }, { session: id }));
  await started.promise;
  await vi.waitFor(() => expect(client.getAttachment(id)?.state.snapshot?.run.state).toBe('running'));
  const finished = vi.fn();
  const waiting = waitForDaemonRun(client, id, runId).then(snapshot => finished({ state: snapshot.run.state }), error => finished({ error }));
  const failure = new Error('unhandled attached projection failure');
  const diagnostic = vi.fn(); f.registry.options.onDiagnostic = diagnostic;
  const projection = f.registry.projection(id);
  const published: number[] = [];
  const unobserve = f.registry.observe(event => { if (event.session === id && 'rev' in event) published.push(event.rev); });
  cleanups.push(async () => unobserve());
  let unpublishedRevision: number | undefined;
  const broken = missedRevision
    ? vi.spyOn(projection, 'history').mockImplementation(() => { unpublishedRevision = f.store.sessionMetadata(id).revision; throw failure; })
    : vi.spyOn(projection, 'syncCursor').mockImplementation(() => { throw failure; });
  if (missedRevision) f.root.runtime.session.sessionManager.appendCustomEntry('projection-failure', {});
  stream.resolve();
  await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith({ scope: 'projection', session: id, error: failure }));
  await f.registry.settleWriters();
  await vi.waitFor(() => expect(finished).toHaveBeenCalledTimes(1));
  await waiting;
  expect(finished).toHaveBeenCalledWith({ state: 'idle' });
  expect(f.store.session(id).run.state).toBe('idle');
  expect(f.registry.fenced).toBe(false);
  if (missedRevision) {
    expect(unpublishedRevision).toBeDefined();
    expect(published).not.toContain(unpublishedRevision);
    expect(published).toContain(unpublishedRevision! + 1);
    expect(clientDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: 'connection.lost' }));
    expect(clientDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: 'attachment.attached', session: id, trigger: 'reconnect', outcome: 'accepted' }));
  }
  await vi.waitFor(() => expect(client.status).toBe('ready'));
  expect(client.getAttachment(id)?.state.status).toBe('live');
  expect(client.getAttachment(other.sessionId)?.state.status).toBe('live');
  const next = accepted(await client.request('prompt', { text: 'unrelated session still works' }, { session: other.sessionId }));
  expect((await waitForDaemonRun(client, other.sessionId, next.runId)).run.state).toBe('idle');
  broken.mockRestore();
  const recovered = accepted(await client.request('prompt', { text: 'the failed session reopens without a manual close' }, { session: id }));
  expect((await waitForDaemonRun(client, id, recovered.runId)).run.state).toBe('idle');
});
