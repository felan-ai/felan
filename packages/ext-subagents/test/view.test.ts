import { expect, it } from 'vitest';
import { parseAgentCatalogSignal, parseAgentOpenRequest, parseAgentOpenResult } from '../src/view.js';

it('opens the current or an explicitly selected agent without executable data', () => {
  expect(parseAgentOpenRequest({})).toEqual({});
  expect(parseAgentOpenRequest({ agentId: 'child-1' })).toEqual({ agentId: 'child-1' });
  expect(parseAgentOpenResult({ opened: true })).toEqual({ opened: true });
});
it('rejects unknown or malformed open instructions', () => {
  for (const value of [{ agentId: '../child' }, { agentId: '' }, { command: 'execute' }, { agentId: 'a', callback: 'run' }])
    expect(() => parseAgentOpenRequest(value)).toThrow();
});
it('requires an explicit acknowledgement rather than truthy answers', () => {
  for (const value of [{ opened: false }, { opened: 'yes' }, {}, { opened: true, extra: 1 }]) expect(() => parseAgentOpenResult(value)).toThrow();
});
it('binds catalog invalidation to a bounded generation digest', () => {
  expect(parseAgentCatalogSignal({ generation: 'a'.repeat(64) })).toEqual({ generation: 'a'.repeat(64) });
  for (const value of [{ generation: 'short' }, { generation: 'a'.repeat(65) }, { generation: 'a'.repeat(64), entries: [] }])
    expect(() => parseAgentCatalogSignal(value)).toThrow();
});
