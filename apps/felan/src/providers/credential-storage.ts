import type { ProviderSecretStorage } from '@felan-ai/daemon/provider';

interface SecretEntry {
  getPassword(signal?: AbortSignal): Promise<string | null | undefined>;
  setPassword(value: string, signal?: AbortSignal): Promise<void>;
  deleteCredential(signal?: AbortSignal): Promise<unknown>;
}

type CreateSecretEntry = (service: string, account: string) => Promise<SecretEntry>;

export function createDaemonSecretStorage(createEntry: CreateSecretEntry = async (service, account) => {
  const { AsyncEntry } = await import('@napi-rs/keyring');
  return new AsyncEntry(service, account);
}): ProviderSecretStorage {
  async function entry(namespace: string, key: string, signal?: AbortSignal): Promise<SecretEntry> {
    signal?.throwIfAborted();
    if (!validIdentifier(namespace, 128) || !validIdentifier(key, 256)) {
      throw new Error('Invalid credential storage address.');
    }
    const result = await createEntry(`felan.${namespace}`, key);
    signal?.throwIfAborted();
    return result;
  }
  return Object.freeze({
    async read(namespace: string, key: string, signal?: AbortSignal) {
      try {
        const value = await (await entry(namespace, key, signal)).getPassword(signal);
        signal?.throwIfAborted();
        return value ?? undefined;
      } catch {
        if (signal?.aborted) throw new DOMException('Credential storage request aborted.', 'AbortError');
        throw new Error('Credential storage read failed.');
      }
    },
    async write(namespace: string, key: string, value: string, signal?: AbortSignal) {
      try {
        if (typeof value !== 'string' || new TextEncoder().encode(value).length > 64 * 1024) {
          throw new Error('Invalid credential storage value.');
        }
        await (await entry(namespace, key, signal)).setPassword(value, signal);
      } catch {
        if (signal?.aborted) throw new DOMException('Credential storage request aborted.', 'AbortError');
        throw new Error('Credential storage write failed.');
      }
    },
    async remove(namespace: string, key: string, signal?: AbortSignal) {
      try {
        await (await entry(namespace, key, signal)).deleteCredential(signal);
      } catch {
        if (signal?.aborted) throw new DOMException('Credential storage request aborted.', 'AbortError');
        throw new Error('Credential storage removal failed.');
      }
    },
  });
}

function validIdentifier(value: string, limit: number): boolean {
  return typeof value === 'string' && value.length <= limit
    && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value)
    && value !== 'constructor' && value !== 'prototype' && value !== '__proto__';
}
