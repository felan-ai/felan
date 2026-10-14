import {
  SECRETS_SERVICE,
  SecretServiceError,
  createFelanServiceRegistry,
  type AgentRuntime,
  type ModelRuntime,
  type SecretAddress,
  type SecretsService,
} from '@felan-ai/agent-core';
import type { ProviderSecretStorage } from '@felan-ai/daemon/provider';
import { describe, expect, it, vi } from 'vitest';
import secretsProvider, { createLocalSecretsService } from '../src/providers/secrets.js';

const address: SecretAddress = { namespace: 'mcp.oauth', key: 'a'.repeat(64) };
const secret = 'private-credential-sentinel';

describe('local Secrets storage service', () => {
  it('exposes only storage and preserves existing namespaces and SHA-256 account keys', async () => {
    const h = fixture();
    expect(Object.isFrozen(h.service)).toBe(true);
    expect(Object.keys(h.service).sort()).toEqual(['read', 'remove', 'write']);
    expect(h.storage.read).not.toHaveBeenCalled();
    expect(await h.service.read(address)).toBeUndefined();
    const written = await h.service.write(address, { value: secret, expectedVersion: null });
    expect(written.value).toBe(secret);
    expect(written.version).toMatch(/^[a-f0-9]{64}$/u);
    expect(written.version).not.toContain(secret);
    expect(h.storage.write).toHaveBeenCalledWith(address.namespace, address.key, secret, undefined);
    expect(await h.service.read(address)).toEqual(written);
    await h.service.remove(address, written.version);
    expect(await h.service.read(address)).toBeUndefined();
    expect(h.storage.remove).toHaveBeenCalledWith(address.namespace, address.key, undefined);
  });

  it('shares opaque content versions across scopes but not different backends or addresses', async () => {
    const h = fixture();
    const otherScope = createLocalSecretsService({ storage: h.storage, namespaces: ['mcp.oauth'] });
    const initial = await h.service.write(address, { value: secret, expectedVersion: null });
    expect(await otherScope.read(address)).toEqual(initial);
    const changed = await otherScope.write(address, { value: 'replacement', expectedVersion: initial.version });
    expect(changed.version).not.toBe(initial.version);
    const restored = await h.service.write(address, { value: secret, expectedVersion: changed.version });
    expect(restored.version).toBe(initial.version);
    const elsewhere = await h.service.write({ ...address, key: 'other' }, { value: secret, expectedVersion: null });
    expect(elsewhere.version).not.toBe(initial.version);
    const otherBackend = fixture();
    expect((await otherBackend.service.write(address, { value: secret, expectedVersion: null })).version).not.toBe(initial.version);
  });

  it('allows exactly one concurrent create across service scopes sharing a backend', async () => {
    const h = fixture();
    const other = createLocalSecretsService({ storage: h.storage, namespaces: ['mcp.oauth'] });
    const results = await Promise.allSettled([
      h.service.write(address, { value: 'first', expectedVersion: null }),
      other.write(address, { value: 'second', expectedVersion: null }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    expect(h.storage.write).toHaveBeenCalledOnce();
  });

  it('serializes concurrent CAS updates and rejects stale updates and deletes without lost writes', async () => {
    const h = fixture();
    const other = createLocalSecretsService({ storage: h.storage, namespaces: ['mcp.oauth'] });
    const initial = await h.service.write(address, { value: 'initial', expectedVersion: null });
    const results = await Promise.allSettled([
      h.service.write(address, { value: 'winner-a', expectedVersion: initial.version }),
      other.write(address, { value: 'winner-b', expectedVersion: initial.version }),
      other.remove(address, initial.version),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(2);
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'conflict' });
    expect(h.storage.write).toHaveBeenCalledTimes(2);
    expect(h.storage.remove).not.toHaveBeenCalled();
    const current = (await other.read(address))!;
    expect(['winner-a', 'winner-b']).toContain(current.value);
    await other.remove(address, current.version);
    await expect(h.service.remove(address, current.version)).rejects.toMatchObject({ code: 'conflict' });
    await expect(h.service.write(address, { value: secret, expectedVersion: current.version })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('snapshots addresses and writes before queued work can observe caller mutations', async () => {
    const h = fixture();
    const entered = deferred<void>();
    const finish = deferred<string | undefined>();
    h.storage.read.mockImplementationOnce(() => { entered.resolve(); return finish.promise; });
    const holding = h.service.read(address);
    await entered.promise;
    const mutable = { ...address };
    const input = { value: 'original', expectedVersion: null as string | null };
    const write = h.service.write(mutable, input);
    mutable.namespace = 'forbidden';
    mutable.key = '../escape';
    input.value = 'mutated';
    input.expectedVersion = 'invalid';
    finish.resolve(undefined);
    await holding;
    expect((await write).value).toBe('original');
    expect(h.storage.write).toHaveBeenCalledWith(address.namespace, address.key, 'original', undefined);
  });

  it.each(['', '.', '..', '../escape', 'a/b', 'a\\b', 'a\0b', 'a\nb', 'a b', '__proto__', 'constructor', 'x.prototype', 'a..b', 'x'.repeat(129)])(
    'rejects invalid key %j before storage access', async key => {
      const h = fixture();
      await expect(h.service.read({ ...address, key })).rejects.toMatchObject({ code: 'invalid' });
      await expect(h.service.write({ ...address, key }, { value: secret, expectedVersion: null })).rejects.toMatchObject({ code: 'invalid' });
      await expect(h.service.remove({ ...address, key }, 'version')).rejects.toMatchObject({ code: 'invalid' });
      expect(h.storage.read).not.toHaveBeenCalled();
      expect(h.storage.write).not.toHaveBeenCalled();
      expect(h.storage.remove).not.toHaveBeenCalled();
    },
  );

  it.each(['../mcp', 'mcp/oauth', '__proto__', 'mcp.constructor', 'x'.repeat(65)])('rejects invalid namespace %j', async namespace => {
    const h = fixture();
    await expect(h.service.read({ ...address, namespace })).rejects.toMatchObject({ code: 'invalid' });
    expect(() => createLocalSecretsService({ storage: h.storage, namespaces: [namespace] })).toThrow(SecretServiceError);
    expect(h.storage.read).not.toHaveBeenCalled();
  });

  it('fails closed for unavailable namespaces and copies its explicit allowlist', async () => {
    const h = fixture();
    const namespaces = ['mcp.oauth'];
    const service = createLocalSecretsService({ storage: h.storage, namespaces });
    namespaces.push('forbidden');
    await expect(service.read({ ...address, namespace: 'forbidden' })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(service.write({ ...address, namespace: 'forbidden' }, { value: secret, expectedVersion: null })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(service.remove({ ...address, namespace: 'forbidden' }, 'version')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(createLocalSecretsService({ storage: h.storage, namespaces: [] }).read(address)).rejects.toMatchObject({ code: 'unavailable' });
    expect(h.storage.read).not.toHaveBeenCalled();
  });

  it('enforces the 64 KiB UTF-8 limit rather than a character-count limit', async () => {
    const h = fixture();
    const maximum = '\u{1f600}'.repeat(16_384);
    const record = await h.service.write(address, { value: maximum, expectedVersion: null });
    expect(record.value).toBe(maximum);
    await expect(h.service.write(address, { value: `${maximum}a`, expectedVersion: record.version })).rejects.toMatchObject({ code: 'invalid' });
    await expect(h.service.write(address, { value: 'x'.repeat(65_537), expectedVersion: record.version })).rejects.toMatchObject({ code: 'invalid' });
    expect(h.storage.write).toHaveBeenCalledOnce();
    const empty = await h.service.write(address, { value: '', expectedVersion: record.version });
    expect(await h.service.read(address)).toEqual(empty);
  });

  it('accepts bounded identifiers and rejects non-string secret values before dispatch', async () => {
    const h = fixture();
    const namespace = 'n'.repeat(64);
    const service = createLocalSecretsService({ storage: h.storage, namespaces: [namespace] });
    const maximum = { namespace, key: 'k'.repeat(128) };
    expect((await service.write(maximum, { value: secret, expectedVersion: null })).value).toBe(secret);
    h.storage.read.mockClear();
    h.storage.write.mockClear();
    for (const value of [null, undefined, 42, { token: secret }]) {
      await expect(service.write(maximum, { value: value as never, expectedVersion: null })).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(h.storage.read).not.toHaveBeenCalled();
    expect(h.storage.write).not.toHaveBeenCalled();
  });

  it.each([undefined, 3, '', 'x'.repeat(129), '../unsafe'])('rejects invalid expected versions %j', async expectedVersion => {
    const h = fixture();
    await expect(h.service.write(address, { value: secret, expectedVersion: expectedVersion as string })).rejects.toMatchObject({ code: 'invalid' });
    await expect(h.service.remove(address, expectedVersion as string)).rejects.toMatchObject({ code: 'invalid' });
    expect(h.storage.read).not.toHaveBeenCalled();
  });

  it('sanitizes backend exceptions including forged service errors and nested causes', async () => {
    const h = fixture();
    const failure = Object.assign(new SecretServiceError('conflict'), {
      message: `${secret} ${address.namespace} ${address.key}`, cause: { token: secret },
    });
    h.storage.read.mockRejectedValueOnce(failure);
    assertSafe(await rejection(h.service.read(address)), 'unavailable');
    h.storage.write.mockRejectedValueOnce(failure);
    assertSafe(await rejection(h.service.write(address, { value: secret, expectedVersion: null })), 'unavailable');
    const current = await h.service.write(address, { value: secret, expectedVersion: null });
    h.storage.remove.mockRejectedValueOnce(failure);
    assertSafe(await rejection(h.service.remove(address, current.version)), 'unavailable');
    expect(await h.service.read(address)).toEqual(current);
  });

  it.each([3, null, 'x'.repeat(65_537)])('rejects malformed or oversized backend records without exposing them', async value => {
    const h = fixture();
    h.storage.read.mockResolvedValueOnce(value as never);
    assertSafe(await rejection(h.service.read(address)), 'unavailable');
    expect(h.storage.write).not.toHaveBeenCalled();
  });

  it('uses safe abort errors and does not access storage for an already cancelled request', async () => {
    const h = fixture();
    const controller = new AbortController();
    controller.abort(new Error(secret));
    for (const work of [
      h.service.read(address, { signal: controller.signal }),
      h.service.write(address, { value: secret, expectedVersion: null }, { signal: controller.signal }),
      h.service.remove(address, 'version', { signal: controller.signal }),
    ]) assertSafe(await rejection(work), 'abort');
    expect(h.storage.read).not.toHaveBeenCalled();
  });

  it('cancels queued work promptly without releasing another scopes lock', async () => {
    const h = fixture();
    const other = createLocalSecretsService({ storage: h.storage, namespaces: ['mcp.oauth'] });
    const entered = deferred<void>();
    const finish = deferred<void>();
    h.storage.write.mockImplementationOnce(async (namespace, key, value) => {
      entered.resolve();
      await finish.promise;
      h.values.set(storageKey(namespace, key), value);
    });
    const first = h.service.write(address, { value: 'first', expectedVersion: null });
    await entered.promise;
    const controller = new AbortController();
    const cancelled = rejection(other.write(address, { value: secret, expectedVersion: null }, { signal: controller.signal }));
    const after = other.read(address);
    controller.abort(secret);
    assertSafe(await cancelled, 'abort');
    expect(h.storage.read).toHaveBeenCalledOnce();
    const independent = await other.write({ ...address, key: 'independent' }, { value: 'parallel', expectedVersion: null });
    expect(independent.value).toBe('parallel');
    finish.resolve();
    expect(await after).toEqual(await first);
    expect(h.storage.write).toHaveBeenCalledTimes(2);
  });

  it('holds the lock until a cancelled in-flight backend read really settles', async () => {
    const h = fixture();
    const entered = deferred<void>();
    const finish = deferred<string | undefined>();
    h.storage.read.mockImplementationOnce(() => { entered.resolve(); return finish.promise; });
    const controller = new AbortController();
    let settled = false;
    const work = rejection(h.service.write(address, { value: secret, expectedVersion: null }, { signal: controller.signal }))
      .then(error => { settled = true; return error; });
    await entered.promise;
    controller.abort(secret);
    const following = h.service.read(address);
    expect(h.storage.read).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    finish.resolve(undefined);
    assertSafe(await work, 'abort');
    expect(await following).toBeUndefined();
    expect(h.storage.write).not.toHaveBeenCalled();
    expect(h.storage.read).toHaveBeenCalledTimes(2);
  });

  it.each(['write', 'remove'] as const)('preserves committed %s success when cancellation arrives inside the backend', async operation => {
    const h = fixture();
    const controller = new AbortController();
    if (operation === 'write') {
      h.storage.write.mockImplementationOnce(async (namespace, key, value, signal) => {
        expect(signal).toBe(controller.signal);
        h.values.set(storageKey(namespace, key), value);
        controller.abort(secret);
      });
      const result = await h.service.write(address, { value: secret, expectedVersion: null }, { signal: controller.signal });
      expect(await h.service.read(address)).toEqual(result);
    } else {
      const record = await h.service.write(address, { value: secret, expectedVersion: null });
      h.storage.remove.mockImplementationOnce(async (namespace, key, signal) => {
        expect(signal).toBe(controller.signal);
        h.values.delete(storageKey(namespace, key));
        controller.abort(secret);
      });
      await h.service.remove(address, record.version, { signal: controller.signal });
      expect(await h.service.read(address)).toBeUndefined();
    }
  });

  it('combines caller and facade lifetime signals without exposing abort reasons', async () => {
    const h = fixture();
    const lifetime = new AbortController();
    const caller = new AbortController();
    const service = createLocalSecretsService({ storage: h.storage, namespaces: ['mcp.oauth'], signal: lifetime.signal });
    await service.read(address, { signal: caller.signal });
    const signal = h.storage.read.mock.calls[0]![2]!;
    expect(signal).not.toBe(caller.signal);
    expect(signal).not.toBe(lifetime.signal);
    caller.abort(secret);
    expect(signal.aborted).toBe(true);
    expect(lifetime.signal.aborted).toBe(false);
    await service.read(address);
    lifetime.abort(secret);
    assertSafe(await rejection(service.read(address)), 'abort');
    expect(h.storage.read).toHaveBeenCalledTimes(2);
  });
});

describe('default session Secrets provider', () => {
  it('declares a session-scoped contract and requires explicit activation', async () => {
    expect(secretsProvider.scope).toBe('session');
    expect(secretsProvider.provides).toEqual([SECRETS_SERVICE]);
    expect(secretsProvider.optionsSchema).toMatchObject({ type: 'object', additionalProperties: false });
    const h = await providerFixture();
    expect(h.instance.implementations[0]!.contract).toBe(SECRETS_SERVICE);
    await unavailable(h.service);
    expect(h.storage.read).not.toHaveBeenCalled();
    await h.instance.activate!();
    const record = await h.service.write(address, { value: secret, expectedVersion: null });
    expect(await h.service.read(address)).toEqual(record);
    await h.instance.dispose();
    await unavailable(h.service);
    await expect(h.instance.activate!()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('uses the default mcp.oauth allowlist and validates configured options', async () => {
    const h = await providerFixture();
    await h.instance.activate!();
    await expect(h.service.read({ ...address, namespace: 'other' })).rejects.toMatchObject({ code: 'unavailable' });
    await h.instance.dispose();
    const scoped = await providerFixture({ options: { namespaces: ['other'] } });
    await scoped.instance.activate!();
    expect(await scoped.service.read({ ...address, namespace: 'other' })).toBeUndefined();
    await expect(scoped.service.read(address)).rejects.toMatchObject({ code: 'unavailable' });
    await scoped.instance.dispose();
    for (const options of [null, [], { extra: true }, { namespaces: 'mcp.oauth' }, { namespaces: ['__proto__'] }, { namespaces: ['mcp.oauth', 'mcp.oauth'] }]) {
      await expect(providerFixture({ options })).rejects.toMatchObject({ code: 'invalid' });
    }
  });

  it('isolates lifetimes while preserving CAS across sessions sharing the same backend', async () => {
    const h = await providerFixture();
    const other = await providerFixture({ storage: h.storage });
    expect(other.service).not.toBe(h.service);
    await h.instance.activate!();
    await other.instance.activate!();
    const record = await h.service.write(address, { value: secret, expectedVersion: null });
    expect(await other.service.read(address)).toEqual(record);
    const results = await Promise.allSettled([
      h.service.write(address, { value: 'first', expectedVersion: record.version }),
      other.service.write(address, { value: 'second', expectedVersion: record.version }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    await h.instance.dispose();
    expect(await other.service.read(address)).toBeDefined();
    await other.instance.dispose();
  });

  it('honors parent lifetime cancellation without leaking the reason or cancelling another scope', async () => {
    const h = await providerFixture();
    const other = await providerFixture({ storage: h.storage });
    await h.instance.activate!();
    await other.instance.activate!();
    h.parent.abort(new Error(secret));
    assertSafe(await rejection(h.service.read(address)), 'abort');
    expect(await other.service.read(address)).toBeUndefined();
    await expect(h.instance.activate!()).rejects.toMatchObject({ code: 'unavailable' });
    await h.instance.dispose();
    await other.instance.dispose();
  });

  it('drains active and queued work without cancellation and refuses new admission', async () => {
    const h = await providerFixture();
    await h.instance.activate!();
    const entered = deferred<void>();
    const finish = deferred<string | undefined>();
    h.storage.read.mockImplementationOnce(() => { entered.resolve(); return finish.promise; });
    const read = h.service.read(address);
    await entered.promise;
    const queued = h.service.write(address, { value: secret, expectedVersion: null });
    const signal = h.storage.read.mock.calls[0]![2]!;
    let settled = false;
    const drain = h.instance.settle!('drain').then(() => { settled = true; });
    await unavailable(h.service);
    expect(signal.aborted).toBe(false);
    expect(settled).toBe(false);
    finish.resolve(undefined);
    expect(await read).toBeUndefined();
    expect((await queued).value).toBe(secret);
    await drain;
    expect(signal.aborted).toBe(false);
    await unavailable(h.service);
    await expect(h.instance.activate!()).rejects.toMatchObject({ code: 'unavailable' });
    await h.instance.dispose();
  });

  it.each(['dispose', 'force'] as const)('%s cancels but waits for real backend settlement and retains the cross-scope lock', async mode => {
    const h = await providerFixture();
    const other = createLocalSecretsService({ storage: h.storage, namespaces: ['mcp.oauth'] });
    await h.instance.activate!();
    const entered = deferred<void>();
    const finish = deferred<string | undefined>();
    h.storage.read.mockImplementationOnce(() => { entered.resolve(); return finish.promise; });
    const read = rejection(h.service.read(address));
    await entered.promise;
    const queued = rejection(h.service.write(address, { value: secret, expectedVersion: null }));
    let settled = false;
    const settlement = (mode === 'dispose' ? h.instance.dispose() : h.instance.settle!('force')).then(() => { settled = true; });
    expect(h.storage.read.mock.calls[0]![2]!.aborted).toBe(true);
    assertSafe(await queued, 'abort');
    await unavailable(h.service);
    const following = other.write(address, { value: 'after', expectedVersion: null });
    expect(settled).toBe(false);
    expect(h.storage.read).toHaveBeenCalledOnce();
    finish.resolve(undefined);
    assertSafe(await read, 'abort');
    await settlement;
    expect((await following).value).toBe('after');
    await h.instance.dispose();
  });

  it('waits for a committed write during disposal without converting success into a rollback claim', async () => {
    const h = await providerFixture();
    await h.instance.activate!();
    const entered = deferred<void>();
    const finish = deferred<void>();
    h.storage.write.mockImplementationOnce(async (namespace, key, value) => {
      h.values.set(storageKey(namespace, key), value);
      entered.resolve();
      await finish.promise;
    });
    const write = h.service.write(address, { value: secret, expectedVersion: null });
    await entered.promise;
    let disposed = false;
    const disposal = h.instance.dispose().then(() => { disposed = true; });
    expect(disposed).toBe(false);
    finish.resolve();
    expect((await write).value).toBe(secret);
    await disposal;
    expect(h.values.get(storageKey(address.namespace, address.key))).toBe(secret);
    await unavailable(h.service);
  });
});

function fixture() {
  const values = new Map<string, string>();
  const storage = {
    read: vi.fn<ProviderSecretStorage['read']>().mockImplementation(async (namespace, key) => values.get(storageKey(namespace, key))),
    write: vi.fn<ProviderSecretStorage['write']>().mockImplementation(async (namespace, key, value) => { values.set(storageKey(namespace, key), value); }),
    remove: vi.fn<ProviderSecretStorage['remove']>().mockImplementation(async (namespace, key) => { values.delete(storageKey(namespace, key)); }),
  } satisfies ProviderSecretStorage;
  const service = createLocalSecretsService({ storage, namespaces: ['mcp.oauth'] });
  return { values, storage, service };
}

async function providerFixture(options: {
  readonly storage?: ReturnType<typeof fixture>['storage'];
  readonly options?: Parameters<typeof secretsProvider.create>[0]['options'];
} = {}) {
  const h = fixture();
  const storage = options.storage ?? h.storage;
  const parent = new AbortController();
  const instance = await secretsProvider.create({
    services: createFelanServiceRegistry(), options: options.options, signal: parent.signal,
    runtime: {} as AgentRuntime, modelRuntime: {} as ModelRuntime,
    sessionId: 'fixture-session', rootSessionId: 'fixture-root', allowedModels: undefined, secretStorage: storage,
  });
  return { ...h, storage, parent, instance, service: instance.implementations[0]!.value as SecretsService };
}

function storageKey(namespace: string, key: string): string { return JSON.stringify([namespace, key]); }

async function unavailable(service: SecretsService): Promise<void> {
  await expect(service.read(address)).rejects.toMatchObject({ code: 'unavailable' });
  await expect(service.write(address, { value: secret, expectedVersion: null })).rejects.toMatchObject({ code: 'unavailable' });
  await expect(service.remove(address, 'version')).rejects.toMatchObject({ code: 'unavailable' });
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  try { await work; } catch (error) { return error; }
  throw new Error('Expected rejection');
}

function assertSafe(error: unknown, code: 'invalid' | 'unavailable' | 'conflict' | 'abort'): void {
  expect(error).toBeInstanceOf(Error);
  if (code === 'abort') expect(error).toMatchObject({ name: 'AbortError', message: 'Secret request aborted.' });
  else expect(error).toMatchObject({ name: 'SecretServiceError', code });
  expect(error).not.toHaveProperty('cause');
  for (const text of [String(error), JSON.stringify(error), (error as Error).stack ?? '']) {
    expect(text).not.toContain(secret);
    expect(text).not.toContain(address.namespace);
    expect(text).not.toContain(address.key);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
