import { describe, expect, it, vi } from 'vitest';
import { createDaemonSecretStorage } from '../src/providers/credential-storage.js';

function fixture() {
  const entries = new Map<string, string>();
  const createEntry = vi.fn(async (service: string, account: string) => {
    const key = `${service}:${account}`;
    return {
      getPassword: vi.fn(async () => entries.get(key) ?? null),
      setPassword: vi.fn(async (value: string) => { entries.set(key, value); }),
      deleteCredential: vi.fn(async () => { entries.delete(key); }),
    };
  });
  return { entries, createEntry, storage: createDaemonSecretStorage(createEntry) };
}

describe('daemon credential storage', () => {
  it('preserves existing MCP keyring identities and payloads without wrapping stored values', async () => {
    const f = fixture();
    const account = `sha256-${'a'.repeat(64)}`;
    const value = '{"version":1,"tokens":{"access_token":"fixture-credential"}}';
    f.entries.set(`felan.mcp.oauth:${account}`, value);
    expect(await f.storage.read('mcp.oauth', account)).toBe(value);
    expect(f.createEntry).toHaveBeenLastCalledWith('felan.mcp.oauth', account);
    await f.storage.write('mcp.oauth', account, 'replacement');
    expect(f.entries.get(`felan.mcp.oauth:${account}`)).toBe('replacement');
    await f.storage.remove('mcp.oauth', account);
    expect(await f.storage.read('mcp.oauth', account)).toBeUndefined();
  });

  it.each(['../outside', '/absolute', 'credential\0name', '__proto__', 'constructor', 'prototype', 'x'.repeat(257)])(
    'rejects unsafe addresses without accessing the credential backend: %j', async key => {
      const f = fixture();
      await expect(f.storage.read('mcp.oauth', key)).rejects.toThrow('Credential storage read failed.');
      await expect(f.storage.write(key, 'entry', 'value')).rejects.toThrow('Credential storage write failed.');
      expect(f.createEntry).not.toHaveBeenCalled();
    },
  );

  it('bounds stored values by UTF-8 bytes', async () => {
    const f = fixture();
    await f.storage.write('mcp.oauth', 'entry', '界'.repeat(21_845));
    f.createEntry.mockClear();
    await expect(f.storage.write('mcp.oauth', 'entry', '界'.repeat(21_846))).rejects.toThrow('Credential storage write failed.');
    expect(f.createEntry).not.toHaveBeenCalled();
  });

  it('checks cancellation before touching storage and after waiting for a handle', async () => {
    const f = fixture();
    const aborted = AbortSignal.abort();
    await expect(f.storage.read('mcp.oauth', 'entry', aborted)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.createEntry).not.toHaveBeenCalled();
    const controller = new AbortController();
    const read = vi.fn(async () => 'value');
    const storage = createDaemonSecretStorage(async () => {
      controller.abort();
      return { getPassword: read, setPassword: async () => {}, deleteCredential: async () => {} };
    });
    await expect(storage.read('mcp.oauth', 'entry', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });

  it('does not report a committed write as rolled back when cancellation arrives afterward', async () => {
    const controller = new AbortController();
    let stored: string | undefined;
    const storage = createDaemonSecretStorage(async () => ({
      getPassword: async () => stored,
      setPassword: async value => { stored = value; controller.abort(); },
      deleteCredential: async () => { stored = undefined; },
    }));
    await expect(storage.write('mcp.oauth', 'entry', 'committed', controller.signal)).resolves.toBeUndefined();
    expect(stored).toBe('committed');
  });

  it('does not expose backend errors or their credential material', async () => {
    const storage = createDaemonSecretStorage(async () => { throw new Error('fixture-secret from keyring'); });
    for (const operation of [() => storage.read('mcp.oauth', 'entry'), () => storage.write('mcp.oauth', 'entry', 'value'), () => storage.remove('mcp.oauth', 'entry')]) {
      const error = await operation().catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty('cause');
      expect(String(error)).not.toContain('fixture-secret');
    }
  });
});
