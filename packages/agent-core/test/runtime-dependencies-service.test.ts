import { describe, expect, it, vi } from 'vitest';
import { RUNTIME_DEPENDENCIES_SERVICE, createExtensionServiceAccess, createFelanServiceRegistry } from '../src/index.js';

describe('host-owned runtime dependency operations', () => {
  it('exposes an optional named operation without callback, command or download authority', async () => {
    const registry = createFelanServiceRegistry();
    const access = createExtensionServiceAccess(registry, { optional: [RUNTIME_DEPENDENCIES_SERVICE] });
    expect(access.get(RUNTIME_DEPENDENCIES_SERVICE)).toBeUndefined();
    const install = vi.fn(async () => ({ status: 'installed' as const }));
    registry.set(RUNTIME_DEPENDENCIES_SERVICE, { install });
    const signal = new AbortController().signal;
    await expect(access.get(RUNTIME_DEPENDENCIES_SERVICE)!.install({ id: 'fixture' }, { signal })).resolves.toEqual({ status: 'installed' });
    expect(install).toHaveBeenCalledExactlyOnceWith({ id: 'fixture' }, { signal });
    expect(RUNTIME_DEPENDENCIES_SERVICE.key).toBe('felan.runtime.dependencies@1');
    registry.revoke();
    expect(() => access.get(RUNTIME_DEPENDENCIES_SERVICE)).toThrow('revoked');
  });
});
