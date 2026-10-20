import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configField, defineExtensionConfig } from '@felan-ai/agent-core';
import { DaemonControlStore } from '../src/daemon/control-store.js';
import { TestHostConfiguration as DaemonConfiguration } from './fixtures/host-services.js';
import { SessionServer } from '../src/daemon/server.js';
import { SessionClient, newRequestId } from '../../felan/src/client/client.js';
import { fixture, fixtures, now, requestId } from './fixtures/registry.js';
import { serverFixture } from './fixtures/server.js';

afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });
const overrides = [{ extensionId: 'codex', source: 'CLI', values: { fast: true } }];

it('retains extension paths through eviction without a session-specific permission', async () => {
  const f = await fixture(); const extensionPaths = [join(f.cwd, 'extension.mjs')];
  const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, extensionPaths });
  expect(f.store.session(binding.sessionId).profile).toEqual({ extensionPaths });
  await f.registry.evictIdle(); await f.registry.restore(binding.sessionId);
  expect(f.opened.at(-1)?.extensionPaths).toEqual(extensionPaths);
});

it('persists execution children with their root extension paths across a restart', async () => {
  const f = await fixture(); const extensionPaths = [join(f.cwd, 'extension.mjs')];
  const root = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, extensionPaths });
  const host = f.registry.executionHost(root.sessionId);
  const child = await host.spawnSession({ prompt: 'task', description: 'task' });
  if (!child.ok) throw new Error(child.error.message);
  await vi.waitFor(() => expect(host.getExecution(child.value.executionId)?.status).toBe('completed'));
  await host.settle();
  const id = child.value.executionId;
  expect(f.store.session(id).profile?.extensionPaths).toEqual(extensionPaths);
  expect(f.opened.find(request => request.parentSessionId === root.sessionId)?.extensionPaths).toEqual(extensionPaths);
  await f.registry.shutdown(); f.store.close();
  const store = new DaemonControlStore(f.owner, { now: () => now }); const registry = f.createRegistry(store); f.replaceRegistry(registry, store);
  await registry.restore(id);
  expect(f.opened.at(-1)?.extensionPaths).toEqual(extensionPaths);
});

it('retains session configuration through eviction and a recovered control store', async () => {
  const f = await fixture();
  const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, extensionConfigOverrides: overrides });
  expect(f.store.session(binding.sessionId).profile).toEqual({ extensionConfigOverrides: overrides });
  await f.registry.evictIdle(); await f.registry.restore(binding.sessionId);
  expect(f.opened.at(-1)?.extensionConfigOverrides).toEqual(overrides);
  await f.registry.shutdown(); f.store.close();
  const store = new DaemonControlStore(f.owner, { now: () => now }); const registry = f.createRegistry(store); f.replaceRegistry(registry, store);
  await registry.restore(binding.sessionId);
  expect(f.opened.at(-1)?.extensionConfigOverrides).toEqual(overrides);
});

it('atomically binds a configuration update to its admitted payload and preserves policy', async () => {
  const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' },
    policy: { mode: 'acp-strict', pendingTightening: false, generation: 1 } });
  const id = requestId(); const values = { extensionConfig: { codex: { fast: true } } };
  f.store.admit({ v: 1, id, op: 'config.set', session: binding.sessionId, params: { scope: 'session', values } }, 'client');
  expect(() => f.store.configureSession(id, { extensionConfig: { codex: { fast: false } } }, overrides)).toThrow('differs');
  expect(f.store.snapshot().requests.find(row => row.id === id)?.phase).toBe('intent');
  await f.registry.reloadAdmitted(id, binding.sessionId, { values, overrides });
  expect(f.store.session(binding.sessionId).profile?.extensionConfigOverrides).toEqual(overrides);
  expect(f.store.session(binding.sessionId).policy.effective).toBe('acp-strict');
  expect(f.store.snapshot().requests.find(row => row.id === id)?.phase).toBe('dispatch_intent');
  expect(f.opened.at(-1)?.extensionConfigOverrides).toEqual(overrides);
  expect(() => f.store.configureSession(id, values, overrides)).toThrow('undispatched');
});

it('persists session configuration during an active run without reloading and applies it on the next reload', async () => {
  const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  f.store.updateSession(binding.sessionId, { run: { state: 'running', id: 'active' } });
  const id = requestId(); const values = { extensionConfig: { codex: { fast: true } } };
  f.store.admit({ v: 1, id, op: 'config.set', session: binding.sessionId, params: { scope: 'session', values } }, 'client');
  const opened = f.opened.length;
  await f.registry.configureAdmitted(id, binding.sessionId, { values, overrides });
  expect(f.store.session(binding.sessionId).profile?.extensionConfigOverrides).toEqual(overrides);
  expect(f.store.snapshot().requests.find(row => row.id === id)?.phase).toBe('dispatch_intent');
  expect(f.opened).toHaveLength(opened); expect(f.registry.binding(binding.sessionId)).toBe(binding);
  f.store.updateSession(binding.sessionId, { run: { state: 'idle' } });
  const reload = requestId(); f.store.admit({ v: 1, id: reload, op: 'session.reload', session: binding.sessionId, params: {} }, 'client');
  await f.registry.reloadAdmitted(reload, binding.sessionId);
  expect(f.opened.at(-1)?.extensionConfigOverrides).toEqual(overrides);
});

it('applies wire creation and reload overrides in real composition without changing global settings or replaying a duplicate', async () => {
  const definition = defineExtensionConfig({ id: 'codex', title: 'Fixture', fields: { fast: configField.boolean({ default: false, description: 'Fixture' }) } });
  const observed: unknown[] = [];
  const f = await serverFixture({ now: Date.now, configDefinitions: [definition], onBind: context => { observed.push(context.extensionConfigs.get('codex')?.fast); } });
  let server: SessionServer | undefined; let client: SessionClient | undefined;
  try {
    const settings = join(f.owner.target.agentDir, 'settings.json'); const before = await readFile(settings);
    server = new SessionServer({ registry: f.registry, models: f.root.runtime.session.modelRuntime, version: 'fixture',
      configuration: new DaemonConfiguration({ definitions: [definition], assertCurrent: () => f.registry.assertAdmission() }) });
    await server.start();
    client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      expected: f.owner.identity, clientVersion: 'fixture', kind: 'tui' });
    await client.connect();
    const created = await client.request('sessions.create', { cwd: f.cwd, config: { extensionConfig: { codex: { fast: true } } } });
    expect(created.outcome).toBe('accepted'); if (created.outcome !== 'accepted') throw new Error('Creation failed');
    const session = created.result.sessionId; await client.attach(session); expect(observed.at(-1)).toBe(true);
    const opens = vi.spyOn(f.profile, 'openSession'); const id = newRequestId();
    const response = await client.request('config.set', { scope: 'session', values: { extensionConfig: { codex: { fast: false } } } }, { session, id });
    expect(response.outcome).toBe('accepted'); expect(observed.at(-1)).toBe(false);
    const count = opens.mock.calls.length;
    expect(await client.request('config.set', { scope: 'session', values: { extensionConfig: { codex: { fast: false } } } }, { session, id })).toEqual(response);
    expect(opens.mock.calls).toHaveLength(count);
    expect(await client.request('config.get', { scope: 'session' }, { session })).toMatchObject({ outcome: 'accepted', result: { values: { extensionConfig: { codex: { fast: false } } } } });
    expect(await readFile(settings)).toEqual(before);
  } finally { client?.close(); server?.close(); await f.dispose(); }
});
