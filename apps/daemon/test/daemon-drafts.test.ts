import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DaemonControlStore } from '../src/daemon/control-store.js';
import { fixture, fixtures, now, offlineModel } from './fixtures/registry.js';

const transcripts = vi.hoisted(() => ({ reading: undefined as (() => void) | undefined, gate: undefined as Promise<void> | undefined }));
vi.mock('../src/daemon/legacy-sessions.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daemon/legacy-sessions.js')>();
  return { ...actual, transcriptHasConversation: async (path: string) => { transcripts.reading?.(); await transcripts.gate; return actual.transcriptHasConversation(path); } };
});

afterEach(async () => {
  transcripts.reading = undefined; transcripts.gate = undefined;
  for (const dispose of fixtures.splice(0)) await dispose();
});

const conversation = (text: string) => JSON.stringify({ type: 'message', id: `user-${text}`, parentId: null, timestamp: 't', message: { role: 'user', content: text, timestamp: now } }) + '\n';

it('keeps a client-created draft out of listings until its first message, and persists the flag', async () => {
  let clock = now; const f = await fixture({ now: () => clock });
  const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, clientRoot: true, sessionDir: join(f.directory, 'client-sessions'), model: offlineModel });
  const id = binding.sessionId;
  expect(f.store.session(id).draft).toBe(true);
  expect(f.registry.listed().map(row => row.id)).not.toContain(id);
  expect(f.registry.list().map(row => row.id)).toContain(id);
  expect(await f.registry.attach(id, { principal: 'owner', kind: 'tui' })).toMatchObject({ snapshot: { session: id } });
  await binding.runtime.session.prompt('first message');
  f.registry.projection(id).refresh();
  expect(f.store.session(id).draft).toBe(false);
  expect(f.registry.listed().map(row => row.id)).toContain(id);
  await f.registry.shutdown(); f.store.close(); const store = new DaemonControlStore(f.owner, { now: () => clock });
  const reopened = f.createRegistry(store); f.replaceRegistry(reopened, store);
  expect(store.session(id)).toMatchObject({ draft: false });
  expect(reopened.listed().map(row => row.id)).toContain(id);
});

it('discards an unused draft after the idle window of a restart, and keeps one that has a conversation', async () => {
  let clock = now; const f = await fixture({ now: () => clock });
  const unused = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, clientRoot: true, sessionDir: join(f.directory, 'client-sessions'), model: offlineModel });
  const used = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, clientRoot: true, sessionDir: join(f.directory, 'client-sessions'), model: offlineModel });
  f.store.putResource({ id: 'finished', root: unused.sessionId, session: unused.sessionId, kind: 'foreground', state: 'exited', updatedAt: now });
  const unusedPath = f.store.session(unused.sessionId).piPath; const usedPath = f.store.session(used.sessionId).piPath;
  await f.registry.shutdown(); f.store.close();
  await appendFile(usedPath, conversation('written before the restart'));
  clock = now + 10_000;
  const store = new DaemonControlStore(f.owner, { now: () => clock });
  const reopened = f.createRegistry(store, 60_000); f.replaceRegistry(reopened, store);
  expect(store.session(unused.sessionId)).toMatchObject({ draft: true });
  expect(await reopened.evictIdle()).toEqual([]);
  clock += 60_000;
  expect(await reopened.evictIdle()).toEqual([unused.sessionId]);
  expect(store.session(unused.sessionId)).toMatchObject({ state: 'closed', residency: 'evicted' });
  expect(store.session(unused.sessionId).deletedAt).toBeDefined();
  await expect(readFile(unusedPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(reopened.attach(unused.sessionId, { principal: 'owner', kind: 'tui' })).rejects.toMatchObject({ code: 'not_found' });
  expect(store.session(used.sessionId)).toMatchObject({ draft: false });
  expect(await readFile(usedPath, 'utf8')).toContain('written before the restart');
  expect(reopened.listed().map(row => row.id)).toContain(used.sessionId);
});

it('keeps an unused draft that is attached within the grace window after a restart', async () => {
  let clock = now; const f = await fixture({ now: () => clock });
  const draft = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, clientRoot: true, sessionDir: join(f.directory, 'client-sessions'), model: offlineModel });
  const id = draft.sessionId; await f.registry.shutdown(); f.store.close();
  clock = now + 10_000;
  const store = new DaemonControlStore(f.owner, { now: () => clock });
  const reopened = f.createRegistry(store, 60_000); f.replaceRegistry(reopened, store);
  const { attachment } = await reopened.attach(id, { principal: 'owner', kind: 'tui' });
  reopened.detach(id, attachment);
  clock += 50_000;
  expect(await reopened.evictIdle()).toEqual([]);
  expect(store.session(id)).toMatchObject({ draft: true });
  expect(store.session(id).deletedAt).toBeUndefined();
  clock += 10_000;
  expect(await reopened.evictIdle()).toEqual([id]);
});

it('keeps a draft that a client attaches while its transcript is being checked', async () => {
  let clock = now; const f = await fixture({ now: () => clock });
  const draft = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, clientRoot: true, sessionDir: join(f.directory, 'client-sessions'), model: offlineModel });
  const id = draft.sessionId; const path = f.store.session(id).piPath;
  await f.registry.shutdown(); f.store.close();
  const store = new DaemonControlStore(f.owner, { now: () => clock });
  const reopened = f.createRegistry(store, 60_000); f.replaceRegistry(reopened, store);
  clock += 60_000;
  let release!: () => void; transcripts.gate = new Promise(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { transcripts.reading = resolve; });
  const eviction = reopened.evictIdle();
  await reading;
  const { snapshot } = await reopened.attach(id, { principal: 'owner', kind: 'tui' });
  release();
  expect(await eviction).toEqual([]);
  expect(snapshot.session).toBe(id);
  expect(store.session(id)).toMatchObject({ draft: true, state: 'open' });
  expect(store.session(id).deletedAt).toBeUndefined();
  expect(await readFile(path, 'utf8')).toContain(id);
});
