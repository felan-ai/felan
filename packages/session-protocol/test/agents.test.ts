import { expect, it } from 'vitest';
import { OPERATION_CATALOG, parseClientEnvelope, parseOperationResult, validateClientEligibility } from '../src/index.js';
import { agent, now, request } from './fixtures.js';

it('keeps agent reads non-mutating and controls durably admitted and TUI-scoped', () => {
  for (const op of ['agents.list', 'agents.read', 'agents.steer', 'agents.cancel'] as const) {
    const input = parseClientEnvelope(request(op), { now });
    expect(() => validateClientEligibility(input, 'tui')).not.toThrow();
    expect(() => validateClientEligibility(input, 'acp')).toThrow();
    expect(() => validateClientEligibility(input, 'headless')).toThrow();
    expect(OPERATION_CATALOG[op].storage).toBe(op === 'agents.list' || op === 'agents.read' ? 'none' : 'durable');
  }
});
it('bounds steering and preserves explicit domain failures and retained results', () => {
  expect(() => parseClientEnvelope(request('agents.steer', { agentId: 'child', message: 'x'.repeat(32 * 1024 + 1) }), { now })).toThrow();
  expect(parseOperationResult('agents.cancel', { ok: false, error: { code: 'not_child', message: 'Different parent' } }))
    .toEqual({ ok: false, error: { code: 'not_child', message: 'Different parent' } });
  expect(parseOperationResult('agents.read', { agent: { ...agent, resultAvailable: true }, result: 'Retained result' }).result).toBe('Retained result');
  expect(() => parseOperationResult('agents.list', { generation: 'short', entries: [] })).toThrow();
});
