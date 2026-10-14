import { expect, it } from 'vitest';
import { OPERATION_CATALOG, parseClientEnvelope, parseOperationResult } from '../src/index.js';
import { execution, now, request } from './fixtures.js';

it('keeps execution reads non-mutating and controls durably admitted for every client kind', () => {
  for (const op of ['executions.list', 'executions.read', 'executions.steer', 'executions.cancel'] as const) {
    expect(parseClientEnvelope(request(op)).op).toBe(op);
    expect(OPERATION_CATALOG[op].storage).toBe(op === 'executions.list' || op === 'executions.read' ? 'none' : 'durable');
  }
});
it('accepts long steering and preserves explicit domain failures and retained results', () => {
  expect(parseClientEnvelope(request('executions.steer', { executionId: 'child', message: 'x'.repeat(32 * 1024 + 1) })).op).toBe('executions.steer');
  expect(parseOperationResult('executions.read', { ...execution, state: 'completed', result: { text: 'Retained result', truncated: false } }).result?.text).toBe('Retained result');
  expect(() => parseOperationResult('executions.list', { items: [{ ...execution, state: 'unknown' }] })).toThrow();
});
