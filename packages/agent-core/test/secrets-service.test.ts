import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  SECRETS_SERVICE,
  SecretServiceError,
  createExtensionServiceAccess,
  createFelanServiceRegistry,
  type SecretAddress,
  type SecretRecord,
  type SecretServiceErrorCode,
  type SecretsRequestOptions,
  type SecretsService,
} from '../src/index.js';

describe('Secrets storage contract', () => {
  it('exposes only versioned storage operations, not host sign-in authority', () => {
    expectTypeOf<SecretAddress>().toEqualTypeOf<{ readonly namespace: string; readonly key: string }>();
    expectTypeOf<SecretRecord>().toEqualTypeOf<{ readonly value: string; readonly version: string }>();
    expectTypeOf<SecretsRequestOptions>().toEqualTypeOf<{ readonly signal?: AbortSignal }>();
    expectTypeOf<SecretServiceErrorCode>().toEqualTypeOf<'invalid' | 'unavailable' | 'conflict'>();
    expectTypeOf<SecretsService>().toEqualTypeOf<{
      read(address: SecretAddress, options?: SecretsRequestOptions): Promise<SecretRecord | undefined>;
      write(address: SecretAddress, record: { readonly value: string; readonly expectedVersion: string | null }, options?: SecretsRequestOptions): Promise<SecretRecord>;
      remove(address: SecretAddress, expectedVersion: string, options?: SecretsRequestOptions): Promise<void>;
    }>();
    expectTypeOf<keyof SecretsService>().toEqualTypeOf<'read' | 'write' | 'remove'>();
  });

  it('uses an explicit major-versioned service and an injected implementation', () => {
    expect(SECRETS_SERVICE).toMatchObject({ id: 'felan.secrets', major: 1, key: 'felan.secrets@1' });
    expect(Object.isFrozen(SECRETS_SERVICE)).toBe(true);
    const registry = createFelanServiceRegistry();
    const access = createExtensionServiceAccess(registry, { required: [SECRETS_SERVICE] });
    expect(() => access.get(SECRETS_SERVICE)).toThrow('no configured provider');
    const service: SecretsService = {
      read: vi.fn<SecretsService['read']>(),
      write: vi.fn<SecretsService['write']>(),
      remove: vi.fn<SecretsService['remove']>(),
    };
    registry.set(SECRETS_SERVICE, service);
    expectTypeOf(access.get(SECRETS_SERVICE)).toEqualTypeOf<SecretsService | undefined>();
    expect(access.get(SECRETS_SERVICE)).toBe(service);
    for (const operation of Object.values(service)) expect(operation).not.toHaveBeenCalled();
    registry.revoke();
    expect(() => access.get(SECRETS_SERVICE)).toThrow('revoked');
  });

  it.each([
    ['invalid', 'Secret request is invalid.'],
    ['unavailable', 'Secret storage is unavailable.'],
    ['conflict', 'Secret version conflict.'],
  ] as const)('uses constant messages for %s without extra error context', (code, message) => {
    const error = new SecretServiceError(code);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'SecretServiceError', code, message });
    expect(error).not.toHaveProperty('cause');
    expect(Object.keys(error).sort()).toEqual(['code', 'name']);
  });

  it('does not expose arbitrary constructor input as a message or error code', () => {
    const secret = 'private-credential-sentinel';
    const error = new SecretServiceError(secret as SecretServiceErrorCode);
    expect(error).toMatchObject({ code: 'invalid', message: 'Secret request is invalid.' });
    expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain(secret);
  });
});
