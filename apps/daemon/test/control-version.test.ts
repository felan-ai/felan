import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DaemonControlStore } from '../src/daemon/control-store.js';
import { fixture, fixtures, requestId } from './fixtures/registry.js';

afterEach(async () => { for (const dispose of fixtures.splice(0)) await dispose(); });

it('persists one version-1 document and reopens it without rewriting or backing it up', async () => {
  const f = await fixture();
  const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  await f.registry.shutdown();
  const state = f.store.snapshot(); const path = join(f.store.directory, 'control.json');
  const original = await readFile(path, 'utf8');
  expect(JSON.parse(original).data).toEqual(state);
  expect(state.version).toBe(1);
  expect(state).not.toHaveProperty('legacy');
  f.store.close();
  const store = new DaemonControlStore(f.owner, { fault: () => { throw new Error('Unexpected write on reopen'); } });
  try {
    expect(store.snapshot()).toEqual(state);
    expect(store.needsRecovery).toBe(true);
    expect(store.session(binding.sessionId).id).toBe(binding.sessionId);
    expect(await readFile(path, 'utf8')).toBe(original);
    expect((await readdir(store.directory)).sort()).toEqual(['control.json', 'format.json']);
  } finally { store.close(); }
});

async function expectQuarantined(f: Awaited<ReturnType<typeof fixture>>, original: string): Promise<void> {
  const store = new DaemonControlStore(f.owner);
  try {
    expect(store.snapshot().sessions).toEqual([]);
    expect(store.needsRecovery).toBe(false);
    const quarantined = (await readdir(store.directory)).filter(name => name.startsWith('control-corrupt-'));
    expect(quarantined).toHaveLength(1);
    expect(await readFile(join(store.directory, quarantined[0]!), 'utf8')).toBe(original);
  } finally { store.close(); }
}

it('quarantines unknown versions and starts with an empty state', async () => {
  const f = await fixture(); await f.registry.shutdown();
  const path = join(f.store.directory, 'control.json'); f.store.close();
  const envelope = JSON.parse(await readFile(path, 'utf8'));
  envelope.data = { version: 999 };
  envelope.digest = createHash('sha256').update(JSON.stringify(envelope.data)).digest('hex');
  const original = JSON.stringify(envelope); await writeFile(path, original, { mode: 0o600 });
  await expectQuarantined(f, original);
});

it('persists session configuration while a run is active without a forced reload', async () => {
  const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  f.store.updateSession(binding.sessionId, { run: { state: 'running', id: 'active-run' } });
  const id = requestId();
  const values = { extensionConfig: { codex: { fast: true } } };
  const overrides = [{ extensionId: 'codex', source: 'session', values: { fast: true } }];
  f.store.admit({ v: 1, id, op: 'config.set', session: binding.sessionId, params: { scope: 'session', values } }, 'owner');
  f.store.configureSession(id, values, overrides);
  expect(f.store.session(binding.sessionId).profile?.extensionConfigOverrides).toEqual(overrides);
  expect(f.store.session(binding.sessionId).run.state).toBe('running');
});

it('resumes an evicted session with the current configuration after a composition change', async () => {
  const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  await f.registry.evictIdle();
  const resolve = f.profile.resolveResources.bind(f.profile);
  f.profile.resolveResources = async request => ({ ...await resolve(request), agentStorageRoot: join(f.owner.target.agentDir, 'different') });
  const restored = await f.registry.restore(binding.sessionId);
  expect(restored.sessionId).toBe(binding.sessionId);
  expect(restored.resources.agentStorageRoot).toBe(join(f.owner.target.agentDir, 'different'));
});

it('quarantines state with unknown fields instead of dropping them', async () => {
  const f = await fixture(); await f.registry.shutdown();
  const state = { ...f.store.snapshot(), unknownData: { retain: true } };
  const path = join(f.store.directory, 'control.json'); f.store.close();
  const envelope = JSON.parse(await readFile(path, 'utf8'));
  envelope.data = state; envelope.digest = createHash('sha256').update(JSON.stringify(state)).digest('hex');
  const original = JSON.stringify(envelope); await writeFile(path, original, { mode: 0o600 });
  await expectQuarantined(f, original);
});
