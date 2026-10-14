import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent';
import { SessionClient, newRequestId } from '../src/client/client.js';
import { createRegistryInteractionBroker } from '../../daemon/src/daemon/broker.js';
import { DaemonConfiguration } from '../src/providers/configuration.js';
import { createRootPreparation } from '../src/providers/project-trust.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const f = await serverFixture({ now: Date.now }); const broker = createRegistryInteractionBroker(f.registry);
  const clients: SessionClient[] = [];
  const prepareRoot = createRootPreparation({ agentDir: f.owner.target.agentDir, homeDir: f.directory, broker, assertCurrent: () => f.owner.assertCurrent() });
  const server = new SessionServer({ registry: f.registry, models: f.root.runtime.session.modelRuntime, version: 'fixture', broker, prepareRoot,
    configuration: new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.owner.assertCurrent() }) });
  cleanup.push(async () => { clients.forEach(client => client.close()); server.close(); await broker.drain(); await server.settleCommands(); await f.dispose(); });
  const settingsFile = join(f.owner.target.agentDir, 'settings.json');
  const settings: unknown = JSON.parse(await readFile(settingsFile, 'utf8'));
  await writeFile(settingsFile, JSON.stringify({ ...(settings as Record<string, unknown>), piExtensions: { project: true } }));
  const project = join(f.cwd, '.pi', 'extensions'); const marker = join(f.cwd, 'extension-loaded');
  await mkdir(project, { recursive: true });
  const extension = join(project, 'fixture.js');
  await writeFile(extension, `import { writeFileSync } from 'node:fs'; export default function () { writeFileSync(${JSON.stringify(marker)}, 'loaded'); }`);
  await server.start();
  async function client(kind: 'tui' | 'acp' | 'headless' = 'tui', dialogs = true) {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      clientVersion: 'fixture', kind, interactionKinds: dialogs ? ['select'] : [], requestTimeoutMs: 3000, retries: 0 });
    clients.push(client); await client.connect(); return client;
  }
  return { ...f, broker, server, client, prepareRoot, extension, marker, request: { cwd: f.cwd, source: 'tui' as const, interactiveExtensions: true } };
}

it.each(['tui', 'acp'] as const)('targets the creating local %s and keeps the host admission lane free until trust is answered', async kind => {
  const f = await fixture(); const creator = await f.client(kind); const other = await f.client(); const id = newRequestId();
  const request = { ...f.request, source: kind };
  const created = creator.request('sessions.create', request, { id });
  await vi.waitFor(() => expect(creator.getInteractions()).toHaveLength(1));
  const interaction = creator.getInteractions()[0]!;
  expect(interaction.scope).toEqual({ kind: 'host', recipient: creator.capabilities!.attachmentId });
  expect(other.getInteractions()).toEqual([]);
  expect(f.store.snapshot().requests.filter(row => row.op === 'sessions.create')).toHaveLength(0);
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  const duplicate = other.request('sessions.create', request, { id });
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

it('cancels creation on creator loss instead of transferring trust to another TUI', async () => {
  const f = await fixture(); const creator = await f.client(); const other = await f.client(); const before = f.registry.list().length;
  const created = creator.request('sessions.create', f.request);
  await vi.waitFor(() => expect(creator.getInteractions()).toHaveLength(1)); creator.close(); await created;
  await vi.waitFor(() => expect(f.broker.pending()).toHaveLength(0)); await f.server.settleCommands();
  expect(f.registry.list()).toHaveLength(before); expect(other.getInteractions()).toEqual([]);
  expect(new ProjectTrustStore(f.owner.target.agentDir).get(f.cwd)).toBeNull();
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('skips untrusted project extensions without a capable TUI and rejects noninteractive explicit paths', async () => {
  const f = await fixture(); const creator = await f.client('tui', false);
  expect(await creator.request('sessions.create', f.request)).toMatchObject({ outcome: 'accepted' });
  expect(f.broker.pending()).toHaveLength(0);
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  const headless = await f.client('headless', false);
  const request = { ...f.request, source: 'headless' as const, interactiveExtensions: false, extensions: [f.extension] };
  expect(await headless.request('sessions.create', request)).toMatchObject({ outcome: 'rejected' });
  await expect(f.prepareRoot(request, { id: 'headless', kind: 'headless', signal: new AbortController().signal }))
    .rejects.toThrow('External extensions require an interactive root session.');
});

it('cancels recipient-bound prompts from a prior broker instance on restart', async () => {
  const f = await fixture();
  f.store.putInteraction({ id: 'old-project-trust', state: 'waiting', createdAt: Date.now(), scope: { kind: 'host', recipient: 'prior-connection' },
    request: { kind: 'confirm', title: 'Load extensions?', message: f.cwd }, });
  const recovered = createRegistryInteractionBroker(f.registry); cleanup.push(() => recovered.drain());
  expect(recovered.pending()).toEqual([]);
  expect(f.store.snapshot().interactions.find(item => item.id === 'old-project-trust')).toMatchObject({ state: 'cancelled', result: { reason: 'restart' } });
});
