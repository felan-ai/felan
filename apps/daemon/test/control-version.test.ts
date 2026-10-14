import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DaemonControlStore } from '../src/daemon/control-store.js';
import { computeControlConfigurationSnapshotIdentity } from '../src/daemon/control-state.js';
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
  expect(state.configurationSnapshots).toContainEqual(f.store.configuration(binding.sessionId));
  f.store.close();
  const store = new DaemonControlStore(f.owner, { fault: () => { throw new Error('Unexpected write on reopen'); } });
  try {
    expect(store.snapshot()).toEqual(state);
    expect(store.needsRecovery).toBe(true);
    expect(store.configuration(binding.sessionId)!.snapshot).toEqual(binding.configuration);
    expect(await readFile(path, 'utf8')).toBe(original);
    expect((await readdir(store.directory)).sort()).toEqual(['control.json', 'format.json']);
  } finally { store.close(); }
});

it('rejects unknown versions without overwriting the current snapshot', async () => {
  const f = await fixture(); await f.registry.shutdown();
  const path = join(f.store.directory, 'control.json'); f.store.close();
  const envelope = JSON.parse(await readFile(path, 'utf8'));
  envelope.data = { version: 999 };
  envelope.digest = createHash('sha256').update(JSON.stringify(envelope.data)).digest('hex');
  const original = JSON.stringify(envelope); await writeFile(path, original, { mode: 0o600 });
  expect(() => new DaemonControlStore(f.owner)).toThrow(/preserve|unsupported/);
  expect(await readFile(path, 'utf8')).toBe(original);
});

it('commits a bounded configuration snapshot atomically and restores it without mutation', async () => {
  const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  const snapshot = f.store.configuration(binding.sessionId)!;
  expect(snapshot.identity).toEqual(computeControlConfigurationSnapshotIdentity(snapshot.snapshot));
  snapshot.snapshot = null;
  expect(f.store.configuration(binding.sessionId)!.snapshot).not.toBeNull();
  await f.registry.shutdown(); f.store.close();
  const store = new DaemonControlStore(f.owner);
  try {
    expect(store.configuration(binding.sessionId)!.snapshot).toEqual(binding.configuration);
    store.recover();
    expect(store.configuration(binding.sessionId)!.snapshot).toEqual(binding.configuration);
  } finally { store.close(); }
});

it.each(['payload', 'digest', 'bytes'] as const)('rejects a configuration %s mismatch without committing the session change', async corruption => {
  const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  const before = f.store.snapshot();
  const snapshot = f.store.configuration(binding.sessionId)!;
  if (corruption === 'payload') snapshot.snapshot = null;
  else if (corruption === 'digest') snapshot.identity.sha256 = 'b'.repeat(64);
  else snapshot.identity.bytes++;
  expect(() => f.store.updateSession(binding.sessionId, { title: 'not committed' }, snapshot)).toThrow('snapshot identity does not match');
  expect(f.store.snapshot()).toEqual(before);
});

it('invalidates configuration inside the transaction and persists an empty snapshot array', async () => {
  const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  const id = requestId();
  const values = { extensionConfig: { codex: { fast: true } } };
  f.store.admit({ v: 1, id, op: 'config.set', session: binding.sessionId, params: { scope: 'session', values } }, 'owner');
  f.store.configureSession(id, values, []);
  expect(f.store.configuration(binding.sessionId)).toBeUndefined();
  expect(f.store.snapshot().configurationSnapshots).toEqual([]);
  expect(JSON.parse(await readFile(join(f.store.directory, 'control.json'), 'utf8')).data.configurationSnapshots).toEqual([]);
});

it('refuses implicit storage remapping and adopts it only through explicit reload', async () => {
  const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  await f.registry.evictIdle();
  const resolve = f.profile.resolveResources.bind(f.profile);
  f.profile.resolveResources = async request => ({ ...await resolve(request), agentStorageRoot: join(f.owner.target.agentDir, 'different') });
  await expect(f.registry.restore(binding.sessionId)).rejects.toMatchObject({ code: 'configuration_recovery_required' });
  expect(f.store.session(binding.sessionId).id).toBe(binding.sessionId);
  const id = requestId();
  f.store.admit({ v: 1, id, op: 'session.reload', session: binding.sessionId, params: {} }, 'owner');
  const reloaded = await f.registry.reloadAdmitted(id, binding.sessionId);
  expect(reloaded.sessionId).toBe(binding.sessionId);
  expect(f.store.configuration(binding.sessionId)!.snapshot).toMatchObject({ environment: { agentStorageRoot: join(f.owner.target.agentDir, 'different') } });
});

it('fails closed rather than dropping unknown state fields', async () => {
  const f = await fixture(); await f.registry.shutdown();
  const state = { ...f.store.snapshot(), unknownData: { retain: true } };
  const path = join(f.store.directory, 'control.json'); f.store.close();
  const envelope = JSON.parse(await readFile(path, 'utf8'));
  envelope.data = state; envelope.digest = createHash('sha256').update(JSON.stringify(state)).digest('hex');
  const original = JSON.stringify(envelope); await writeFile(path, original, { mode: 0o600 });
  expect(() => new DaemonControlStore(f.owner)).toThrow(/preserve/);
  expect(await readFile(path, 'utf8')).toBe(original);
});
