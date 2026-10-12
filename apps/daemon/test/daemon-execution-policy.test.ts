import { describe, expect, it } from 'vitest';
import { inheritExecutionPolicy, TrustedToolCatalog } from '../src/daemon/execution-policy.js';

describe('daemon execution policy', () => {
  it('inherits pending and strict policy without a per-attachment downgrade', () => {
    const pending = { mode: 'host-default', pendingTightening: true, generation: 1 } as const;
    const child = inheritExecutionPolicy(pending);
    expect(child).toEqual(pending);
    expect(child).not.toBe(pending);
    const strict = inheritExecutionPolicy({ mode: 'acp-strict', pendingTightening: false, generation: 2 });
    expect(inheritExecutionPolicy(strict)).toEqual(strict);
    expect(Object.isFrozen(strict)).toBe(true);
  });

  it('exempts only safe names with the exact trusted registered implementation', () => {
    const builtin = {};
    const external = {};
    let current = builtin;
    const catalog = new TrustedToolCatalog(() => current);
    const policy = { mode: 'acp-strict', pendingTightening: false, generation: 0 } as const;
    catalog.register('read', builtin, 'builtin', '@felan-ai/agent-core');
    expect(catalog.requiresApproval(policy, 'read')).toBe(false);
    current = external;
    expect(catalog.requiresApproval(policy, 'read')).toBe(true);
    catalog.register('read', external, 'external', 'replacement');
    expect(catalog.requiresApproval(policy, 'read')).toBe(true);
    catalog.register('bash', builtin, 'builtin', '@felan-ai/agent-core');
    expect(catalog.requiresApproval(policy, 'bash')).toBe(true);
    expect(catalog.requiresApproval(policy, 'unknown')).toBe(true);
    expect(catalog.provenance).toContainEqual({ name: 'read', source: 'external', sourceId: 'replacement' });
  });

  it('rejects invalid restored policy', () => {
    for (const policy of [
      { mode: 'host-default', pendingTightening: false, generation: -1 },
      { mode: 'acp-strict', pendingTightening: true, generation: 1 },
    ]) expect(() => inheritExecutionPolicy(policy as never)).toThrow('Invalid');
  });
});
