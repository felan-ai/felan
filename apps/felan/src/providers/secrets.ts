import { createHmac, randomBytes } from 'node:crypto';
import {
  SECRETS_SERVICE,
  SECRETS_LIMITS,
  SecretServiceError,
  type SecretAddress,
  type SecretRecord,
  type SecretsRequestOptions,
  type SecretsService,
} from '@felan-ai/agent-core';
import { defineServiceProvider, type ProviderSecretStorage } from '@felan-ai/daemon/provider';
import { Type } from 'typebox';

export interface CreateLocalSecretsServiceOptions {
  readonly storage: ProviderSecretStorage;
  readonly namespaces: readonly string[];
  readonly signal?: AbortSignal;
  readonly isActive?: () => boolean;
}

interface Waiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  readonly abort: () => void;
}

interface BackendState {
  readonly salt: Buffer;
  readonly locks: Map<string, Waiter[]>;
}

const backends = new WeakMap<ProviderSecretStorage, BackendState>();
const identifier = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/u;

export function createLocalSecretsService(options: CreateLocalSecretsServiceOptions): SecretsService {
  if (!options || typeof options !== 'object') throw new SecretServiceError('invalid');
  const namespaces = namespaceAllowlist(options.namespaces);
  const { storage } = options;
  if (!storage || typeof storage.read !== 'function' || typeof storage.write !== 'function' || typeof storage.remove !== 'function') {
    throw new SecretServiceError('invalid');
  }
  let state = backends.get(storage);
  if (!state) {
    state = { salt: randomBytes(32), locks: new Map() };
    backends.set(storage, state);
  }
  const backend = state;

  function version(address: SecretAddress, value: string): string {
    return createHmac('sha256', backend.salt).update(JSON.stringify([address.namespace, address.key, value])).digest('hex');
  }

  async function stored(address: SecretAddress, signal?: AbortSignal): Promise<string | undefined> {
    let value: unknown;
    try { value = await storage.read(address.namespace, address.key, signal); }
    catch { throw new SecretServiceError('unavailable'); }
    checkAbort(signal);
    if (value !== undefined && !validValue(value)) throw new SecretServiceError('unavailable');
    return value as string | undefined;
  }

  async function run<T>(
    address: SecretAddress,
    request: SecretsRequestOptions | undefined,
    prepare: () => (address: SecretAddress, signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let signal: AbortSignal | undefined;
    try {
      if (options.isActive?.() === false) throw new SecretServiceError('unavailable');
      signal = requestSignal(options.signal, request);
      checkAbort(signal);
      if (!address) throw new SecretServiceError('invalid');
      const copied = { namespace: address.namespace, key: address.key };
      if (!validIdentifier(copied.namespace, SECRETS_LIMITS.namespaceBytes) || !validIdentifier(copied.key, SECRETS_LIMITS.keyBytes)) {
        throw new SecretServiceError('invalid');
      }
      if (!namespaces.has(copied.namespace)) throw new SecretServiceError('unavailable');
      const operation = prepare();
      const release = await acquire(backend, `${copied.namespace}\0${copied.key}`, signal);
      try {
        checkAbort(signal);
        return await operation(copied, signal);
      } finally { release(); }
    } catch (error) {
      if (signal?.aborted) throw aborted();
      throw new SecretServiceError(error instanceof SecretServiceError ? error.code : 'unavailable');
    }
  }

  return Object.freeze({
    read: (address, request) => run(address, request, () => async (copied, signal) => {
      const value = await stored(copied, signal);
      return value === undefined ? undefined : { value, version: version(copied, value) };
    }),
    write: (address, record, request) => run(address, request, () => {
      if (!record) throw new SecretServiceError('invalid');
      const { value, expectedVersion } = record;
      if (!validValue(value) || expectedVersion !== null && !validVersion(expectedVersion)) {
        throw new SecretServiceError('invalid');
      }
      return async (copied, signal): Promise<SecretRecord> => {
        const current = await stored(copied, signal);
        if (expectedVersion === null ? current !== undefined : current === undefined || version(copied, current) !== expectedVersion) {
          throw new SecretServiceError('conflict');
        }
        checkAbort(signal);
        const result = { value, version: version(copied, value) };
        try { await storage.write(copied.namespace, copied.key, value, signal); }
        catch { throw new SecretServiceError('unavailable'); }
        // A resolved write is committed even when cancellation arrived during the backend call.
        return result;
      };
    }),
    remove: (address, expectedVersion, request) => run(address, request, () => {
      if (!validVersion(expectedVersion)) throw new SecretServiceError('invalid');
      const expected = expectedVersion;
      return async (copied, signal) => {
        const current = await stored(copied, signal);
        if (current === undefined || version(copied, current) !== expected) throw new SecretServiceError('conflict');
        checkAbort(signal);
        try { await storage.remove(copied.namespace, copied.key, signal); }
        catch { throw new SecretServiceError('unavailable'); }
      };
    }),
  } satisfies SecretsService);
}

function validIdentifier(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit && identifier.test(value) && !value.includes('..')
    && !value.toLowerCase().includes('__proto__')
    && !value.toLowerCase().split(/[._-]/u).some(part => part === 'constructor' || part === 'prototype');
}

function validValue(value: unknown): value is string {
  return typeof value === 'string' && value.length <= SECRETS_LIMITS.valueBytes && Buffer.byteLength(value, 'utf8') <= SECRETS_LIMITS.valueBytes;
}

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= SECRETS_LIMITS.versionBytes && /^[a-zA-Z0-9_-]+$/u.test(value);
}

function namespaceAllowlist(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length > 64 || Array.from(value).some(namespace => !validIdentifier(namespace, SECRETS_LIMITS.namespaceBytes))
    || new Set(value).size !== value.length) throw new SecretServiceError('invalid');
  return new Set(value as string[]);
}

function requestSignal(lifetime: AbortSignal | undefined, request: SecretsRequestOptions | undefined): AbortSignal | undefined {
  if (request !== undefined && (!request || typeof request !== 'object')) throw new SecretServiceError('invalid');
  const signal = request?.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal) || lifetime !== undefined && !(lifetime instanceof AbortSignal)) {
    throw new SecretServiceError('invalid');
  }
  return lifetime && signal ? AbortSignal.any([lifetime, signal]) : lifetime ?? signal;
}

function aborted(): Error { return new DOMException('Secret request aborted.', 'AbortError'); }

function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw aborted(); }

function acquire(backend: BackendState, key: string, signal?: AbortSignal): Promise<() => void> {
  return new Promise<() => void>((resolve, reject) => {
    if (signal?.aborted) { reject(aborted()); return; }
    let waiters = backend.locks.get(key);
    if (!waiters) {
      waiters = [];
      backend.locks.set(key, waiters);
      resolve(releaseFor(waiters));
      return;
    }
    const queue = waiters;
    const waiter: Waiter = { resolve, reject, signal, abort: () => {
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      signal?.removeEventListener('abort', waiter.abort);
      reject(aborted());
    } };
    queue.push(waiter);
    signal?.addEventListener('abort', waiter.abort, { once: true });

    function releaseFor(queue: Waiter[]): () => void {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = queue.shift();
        if (!next) { backend.locks.delete(key); return; }
        next.signal?.removeEventListener('abort', next.abort);
        next.resolve(releaseFor(queue));
      };
    }
  });
}

const optionsSchema = Type.Object({
  namespaces: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64, pattern: identifier.source }), { maxItems: 64, uniqueItems: true })),
}, { additionalProperties: false });

export default defineServiceProvider({
  scope: 'session',
  provides: [SECRETS_SERVICE],
  optionsSchema,
  async create(context) {
    const configured = context.options;
    let namespaces: unknown = ['mcp.oauth'];
    if (configured !== undefined) {
      if (!configured || typeof configured !== 'object' || Array.isArray(configured)
        || Object.keys(configured).some(key => key !== 'namespaces')) throw new SecretServiceError('invalid');
      if ('namespaces' in configured) namespaces = configured.namespaces;
    }
    const lifetime = new AbortController();
    let state: 'created' | 'active' | 'settling' | 'disposed' = 'created';
    const service = createLocalSecretsService({ storage: context.secretStorage, namespaces: [...namespaceAllowlist(namespaces)],
      signal: AbortSignal.any([context.signal, lifetime.signal]), isActive: () => state === 'active' });
    const active = new Set<Promise<unknown>>();
    const track = <T>(work: Promise<T>): Promise<T> => {
      active.add(work);
      void work.then(() => active.delete(work), () => active.delete(work));
      return work;
    };
    const value = Object.freeze({
      read: (...args) => track(service.read(...args)),
      write: (...args) => track(service.write(...args)),
      remove: (...args) => track(service.remove(...args)),
    } satisfies SecretsService);
    const drain = async () => { while (active.size) await Promise.allSettled([...active]); };
    return {
      implementations: [{ contract: SECRETS_SERVICE, value }],
      async activate() {
        if (state !== 'created' && state !== 'active' || lifetime.signal.aborted || context.signal.aborted) throw new SecretServiceError('unavailable');
        state = 'active';
      },
      async settle(mode: 'drain' | 'force') { if (state !== 'disposed') state = 'settling'; if (mode === 'force') lifetime.abort(); await drain(); },
      async dispose() { state = 'disposed'; lifetime.abort(); await drain(); },
    };
  },
});
