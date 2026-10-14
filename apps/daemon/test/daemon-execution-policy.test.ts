import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@felan-ai/agent-core';
import { inheritExecutionPolicy, TrustedToolCatalog } from '../src/daemon/execution-policy.js';

describe('daemon execution policy', () => {
  it('inherits host-default and strict policy as frozen copies', () => {
    const host = { mode: 'host-default', generation: 1 } as const;
    const child = inheritExecutionPolicy(host);
    expect(child).toEqual(host);
    expect(child).not.toBe(host);
    const strict = inheritExecutionPolicy({ mode: 'acp-strict', generation: 2 });
    expect(inheritExecutionPolicy(strict)).toEqual(strict);
    expect(Object.isFrozen(strict)).toBe(true);
  });

  it('exempts only configured names with the exact trusted registered implementation', () => {
    const builtin = {};
    const external = {};
    let current = builtin;
    const catalog = new TrustedToolCatalog(() => current, ['read']);
    const policy = { mode: 'acp-strict', generation: 0 } as const;
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

  it('takes trusted inline identities and exemptions only from the provider policy', () => {
    const implementation = {};
    const session = {
      getToolDefinition: () => implementation,
      getAllTools: () => [
        { name: 'inspect', sourceInfo: { path: '<inline:configured-provider>' } },
        { name: 'external', sourceInfo: { path: '<inline:unconfigured-provider>' } },
        { name: 'write', sourceInfo: { path: '<inline:configured-provider>' } },
        { name: 'native', sourceInfo: { path: 'builtin:native' } },
      ],
    } as unknown as AgentSession;
    const policy = { mode: 'acp-strict', generation: 0 } as const;
    const configured = TrustedToolCatalog.fromSession(session, {
      trustedInlinePaths: ['<inline:configured-provider>'], approvalExemptTools: ['inspect', 'external', 'native'],
    });
    expect(configured.requiresApproval(policy, 'inspect')).toBe(false);
    expect(configured.requiresApproval(policy, 'native')).toBe(false);
    expect(configured.requiresApproval(policy, 'external')).toBe(true);
    expect(configured.requiresApproval(policy, 'write')).toBe(true);
    const unconfigured = TrustedToolCatalog.fromSession(session);
    expect(unconfigured.requiresApproval(policy, 'inspect')).toBe(true);
    expect(unconfigured.requiresApproval(policy, 'native')).toBe(true);
    expect(unconfigured.requiresApproval({ ...policy, mode: 'host-default' }, 'external')).toBe(false);
  });

  it('rejects invalid restored policy', () => {
    for (const policy of [
      { mode: 'host-default', generation: -1 },
      { mode: 'unknown', generation: 1 },
    ]) expect(() => inheritExecutionPolicy(policy as never)).toThrow('Invalid');
  });
});
