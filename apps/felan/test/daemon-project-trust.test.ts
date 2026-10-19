import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent';
import { parseClientEnvelope } from '@felan-ai/session-protocol';
import { SessionClient, newRequestId } from '../src/client/client.js';
import { createRegistryInteractionBroker } from '../../daemon/src/daemon/broker.js';
import { DaemonConfiguration } from '../src/providers/configuration.js';
import { createRootPreparation } from '../src/providers/project-trust.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(piExtensions: { user?: boolean; project?: boolean } = { project: true }) {
  const f = await serverFixture({ now: Date.now }); const broker = createRegistryInteractionBroker(f.registry);
  const clients: SessionClient[] = [];
  const prepareRoot = createRootPreparation({ agentDir: f.owner.target.agentDir, homeDir: f.directory, broker, assertCurrent: () => f.owner.assertCurrent() });
  const server = new SessionServer({ registry: f.registry, models: f.root.runtime.session.modelRuntime, version: 'fixture', broker, prepareRoot,
    configuration: new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.owner.assertCurrent() }) });
  cleanup.push(async () => { clients.forEach(client => client.close()); server.close(); await broker.drain(); await server.settleCommands(); await f.dispose(); });
  const settingsFile = join(f.owner.target.agentDir, 'settings.json');
  const settings: unknown = JSON.parse(await readFile(settingsFile, 'utf8'));
  await writeFile(settingsFile, JSON.stringify({ ...(settings as Record<string, unknown>), piExtensions }));
  const project = join(f.cwd, '.pi', 'extensions'); const marker = join(f.cwd, 'extension-loaded');
  await mkdir(project, { recursive: true });
  const extension = join(project, 'fixture.js');
  await writeFile(extension, `import { writeFileSync } from 'node:fs'; export default function () { writeFileSync(${JSON.stringify(marker)}, 'loaded'); }`);
  const user = join(f.directory, '.pi', 'agent', 'extensions'); const userMarker = join(f.cwd, 'user-extension-loaded');
  await mkdir(user, { recursive: true }); const userExtension = join(user, 'fixture.js');
  await writeFile(userExtension, `import { writeFileSync } from 'node:fs'; export default function () { writeFileSync(${JSON.stringify(userMarker)}, 'loaded'); }`);
  await server.start();
  async function client(kind: 'tui' | 'acp' | 'headless' = 'tui', dialogs = true) {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      clientVersion: 'fixture', kind, interactionKinds: dialogs ? ['select'] : [], requestTimeoutMs: 3000, retries: 0 });
    clients.push(client); await client.connect(); return client;
  }
  return { ...f, broker, server, client, prepareRoot, extension, marker, userExtension, userMarker, request: { cwd: f.cwd } };
}

it('targets only the creating TUI and keeps the host admission lane free until trust is answered', async () => {
  const f = await fixture(); const creator = await f.client(); const other = await f.client(); const id = newRequestId();
  const created = creator.request('sessions.create', f.request, { id });
  await vi.waitFor(() => expect(creator.getInteractions()).toHaveLength(1));
  const interaction = creator.getInteractions()[0]!;
  expect(interaction.scope).toEqual({ kind: 'host', recipient: creator.capabilities!.attachmentId });
  expect(other.getInteractions()).toEqual([]);
  expect(f.store.snapshot().requests.filter(row => row.op === 'sessions.create')).toHaveLength(0);
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  const duplicate = other.request('sessions.create', f.request, { id });
  expect(await other.request('interaction.answer', { interactionId: interaction.id, answer: { kind: 'select', choices: ['trust'] } }))
    .toMatchObject({ error: { code: 'forbidden' } });
  expect(await other.request('config.set', { scope: 'global', values: { defaultThinking: 'low' } })).toMatchObject({ outcome: 'accepted' });
  expect(await creator.request('interaction.answer', { interactionId: interaction.id, answer: { kind: 'select', choices: ['trust'] } }))
    .toMatchObject({ outcome: 'accepted' });
  const first = await created; expect(first.outcome).toBe('accepted'); expect(await duplicate).toEqual(first);
  expect(await readFile(f.marker, 'utf8')).toBe('loaded');
  expect(new ProjectTrustStore(f.owner.target.agentDir).get(f.cwd)).toBe(true);
  if (first.outcome !== 'accepted') throw new Error('Session creation failed.');
  expect(f.store.session(first.result.sessionId).profile?.extensionPaths).toEqual([f.extension]);
});

it('remembers denial without importing project code and does not ask again', async () => {
  const f = await fixture(); const creator = await f.client();
  const created = creator.request('sessions.create', f.request);
  await vi.waitFor(() => expect(creator.getInteractions()).toHaveLength(1));
  await creator.request('interaction.answer', { interactionId: creator.getInteractions()[0]!.id, answer: { kind: 'select', choices: ['deny'] } });
  expect(await created).toMatchObject({ outcome: 'accepted' });
  expect(new ProjectTrustStore(f.owner.target.agentDir).get(f.cwd)).toBe(false);
  expect(await creator.request('sessions.create', f.request)).toMatchObject({ outcome: 'accepted' });
  expect(creator.getInteractions()).toEqual([]); await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('remembers parent trust and applies it to a later non-TUI root', async () => {
  const f = await fixture(); const creator = await f.client();
  const created = creator.request('sessions.create', f.request);
  await vi.waitFor(() => expect(creator.getInteractions()).toHaveLength(1));
  await creator.request('interaction.answer', { interactionId: creator.getInteractions()[0]!.id, answer: { kind: 'select', choices: ['trust-parent'] } });
  expect(await created).toMatchObject({ outcome: 'accepted' });
  expect(new ProjectTrustStore(f.owner.target.agentDir).get(dirname(f.cwd))).toBe(true);
  const headless = await f.client('headless');
  expect(await headless.request('sessions.create', f.request)).toMatchObject({ outcome: 'accepted' });
  expect(headless.getInteractions()).toEqual([]);
});

it('does not save a trust decision after dismissal and still loads enabled user extensions', async () => {
  const f = await fixture({ user: true, project: true }); const creator = await f.client();
  const created = creator.request('sessions.create', f.request);
  await vi.waitFor(() => expect(creator.getInteractions()).toHaveLength(1));
  await creator.request('interaction.answer', { interactionId: creator.getInteractions()[0]!.id, answer: { cancelled: true, reason: 'user' } });
  const response = await created;
  expect(response.outcome).toBe('accepted'); if (response.outcome !== 'accepted') throw new Error('Create failed');
  expect(f.store.session(response.result.sessionId).profile?.extensionPaths).toEqual([f.userExtension]);
  expect(new ProjectTrustStore(f.owner.target.agentDir).get(f.cwd)).toBeNull();
  expect(await readFile(f.userMarker, 'utf8')).toBe('loaded'); await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cancels creation on creator loss instead of transferring trust to another TUI', async () => {
  const f = await fixture(); const creator = await f.client(); const other = await f.client(); const before = f.registry.list().length;
  const created = creator.request('sessions.create', f.request);
  await vi.waitFor(() => expect(creator.getInteractions()).toHaveLength(1)); creator.close(); await created;
  await vi.waitFor(() => expect(f.broker.pending()).toHaveLength(0)); await f.server.settleCommands();
  expect(f.registry.list()).toHaveLength(before); expect(other.getInteractions()).toEqual([]);
  expect(new ProjectTrustStore(f.owner.target.agentDir).get(f.cwd)).toBeNull();
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([
  { kind: 'tui', dialogs: false }, { kind: 'acp', dialogs: true }, { kind: 'headless', dialogs: true }, { kind: 'headless', dialogs: false },
] as const)('skips undecided project code without prompting or saving a decision for $kind/$dialogs', async ({ kind, dialogs }) => {
  const f = await fixture({ user: true, project: true }); const observer = await f.client(); const creator = await f.client(kind, dialogs);
  const prompt = vi.spyOn(f.broker, 'request');
  const response = await creator.request('sessions.create', f.request);
  expect(response.outcome).toBe('accepted'); if (response.outcome !== 'accepted') throw new Error('Create failed');
  expect(f.store.session(response.result.sessionId).profile?.extensionPaths).toEqual([f.userExtension]);
  expect(prompt).not.toHaveBeenCalled(); expect(creator.getInteractions()).toEqual([]); expect(observer.getInteractions()).toEqual([]);
  expect(new ProjectTrustStore(f.owner.target.agentDir).get(f.cwd)).toBeNull();
  expect(await readFile(f.userMarker, 'utf8')).toBe('loaded');
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['acp', 'headless'] as const)('loads host user and already-trusted project extensions for %s roots and their children', async kind => {
  const f = await fixture({ user: true, project: true }); const creator = await f.client(kind);
  new ProjectTrustStore(f.owner.target.agentDir).set(f.cwd, true);
  const prompt = vi.spyOn(f.broker, 'request');
  const response = await creator.request('sessions.create', f.request);
  expect(response.outcome).toBe('accepted'); if (response.outcome !== 'accepted') throw new Error('Create failed');
  const root = response.result.sessionId;
  expect(f.store.session(root).profile?.extensionPaths).toEqual([f.userExtension, f.extension]);
  expect(await readFile(f.userMarker, 'utf8')).toBe('loaded'); expect(await readFile(f.marker, 'utf8')).toBe('loaded');
  const host = f.registry.executionHost(root);
  const child = await host.spawnSession({ prompt: 'task', description: 'task' });
  if (!child.ok) throw new Error(child.error.message);
  await vi.waitFor(() => expect(host.getExecution(child.value.executionId)?.status).toBe('completed'));
  await host.settle();
  expect(f.store.session(child.value.executionId).profile?.extensionPaths).toEqual([f.userExtension, f.extension]);
  expect(prompt).not.toHaveBeenCalled();
});

it.each([false, true])('prepares remote roots without prompting, honoring existing project trust: %s', async trusted => {
  const f = await fixture({ user: true, project: true }); const observer = await f.client();
  if (trusted) new ProjectTrustStore(f.owner.target.agentDir).set(f.cwd, true);
  const prompt = vi.spyOn(f.broker, 'request'); const id = newRequestId();
  const response = await f.server.submitRemote(parseClientEnvelope({ v: 1, id, op: 'sessions.create', params: f.request }), { user: 'web-user', command: id });
  expect(response.outcome).toBe('accepted'); if (response.outcome !== 'accepted') throw new Error('Create failed');
  expect(f.store.session((response.result as { sessionId: string }).sessionId).profile?.extensionPaths).toEqual([f.userExtension, ...(trusted ? [f.extension] : [])]);
  expect(prompt).not.toHaveBeenCalled(); expect(observer.getInteractions()).toEqual([]);
  expect(new ProjectTrustStore(f.owner.target.agentDir).get(f.cwd)).toBe(trusted ? true : null);
  expect(await readFile(f.userMarker, 'utf8')).toBe('loaded');
  if (trusted) expect(await readFile(f.marker, 'utf8')).toBe('loaded');
  else await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([{}, { user: false, project: false }])('loads no ambient extensions with host settings off: %j', async settings => {
  const f = await fixture(settings); const creator = await f.client(); new ProjectTrustStore(f.owner.target.agentDir).set(f.cwd, true);
  const prompt = vi.spyOn(f.broker, 'request');
  const response = await creator.request('sessions.create', f.request);
  expect(response.outcome).toBe('accepted'); if (response.outcome !== 'accepted') throw new Error('Create failed');
  expect(f.store.session(response.result.sessionId).profile?.extensionPaths).toBeUndefined();
  expect(prompt).not.toHaveBeenCalled();
  await expect(readFile(f.userMarker)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('allows explicit extension paths from a local non-TUI client even with host discovery off', async () => {
  const f = await fixture({}); const creator = await f.client('headless', false); const prompt = vi.spyOn(f.broker, 'request');
  const response = await creator.request('sessions.create', { ...f.request, extensions: [f.extension] });
  expect(response.outcome).toBe('accepted'); if (response.outcome !== 'accepted') throw new Error('Create failed');
  expect(f.store.session(response.result.sessionId).profile?.extensionPaths).toEqual([f.extension]);
  expect(await readFile(f.marker, 'utf8')).toBe('loaded'); expect(prompt).not.toHaveBeenCalled();
  expect(new ProjectTrustStore(f.owner.target.agentDir).get(f.cwd)).toBeNull();
});

it('uses host extension settings for an imported root', async () => {
  const f = await fixture({ user: true, project: true }); const creator = await f.client('acp');
  new ProjectTrustStore(f.owner.target.agentDir).set(f.cwd, true);
  const response = await creator.request('session.import', { cwd: f.cwd, path: f.store.session(f.root.sessionId).piPath });
  expect(response.outcome).toBe('accepted'); if (response.outcome !== 'accepted') throw new Error('Import failed');
  expect(f.store.session(response.result.sessionId).profile?.extensionPaths).toEqual([f.userExtension, f.extension]);
  expect(creator.getInteractions()).toEqual([]);
  expect(await readFile(f.userMarker, 'utf8')).toBe('loaded'); expect(await readFile(f.marker, 'utf8')).toBe('loaded');
});

it('cancels recipient-bound prompts from a prior broker instance on restart', async () => {
  const f = await fixture();
  f.store.putInteraction({ id: 'old-project-trust', state: 'waiting', createdAt: Date.now(), scope: { kind: 'host', recipient: 'prior-connection' },
    request: { kind: 'confirm', title: 'Load extensions?', message: f.cwd }, });
  const recovered = createRegistryInteractionBroker(f.registry); cleanup.push(() => recovered.drain());
  expect(recovered.pending()).toEqual([]);
  expect(f.store.snapshot().interactions.find(item => item.id === 'old-project-trust')).toMatchObject({ state: 'cancelled', result: { reason: 'restart' } });
});
