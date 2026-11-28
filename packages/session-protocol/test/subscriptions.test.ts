import { expect, it } from 'vitest';
import { OPERATION_CATALOG, ProtocolValidationError, parseClientEnvelope, parseOperationResult } from '../src/index.js';
import { now, request } from './fixtures.js';

const usage = { provider: 'anthropic', modelProvider: 'anthropic', label: 'Claude Plan',
  windows: [{ label: '5h', usedPercent: 0, resetAt: new Date(now).toISOString() }, { label: 'Week', usedPercent: 100 }], updatedAt: now };

it('reads subscription usage as a non-durable host operation without a session', () => {
  expect(OPERATION_CATALOG['host.subscriptions']).toEqual({ scope: 'host', mutation: false, storage: 'none' });
  expect(parseClientEnvelope({ ...request('host.subscriptions'), id: 'poll' }).op).toBe('host.subscriptions');
  expect(() => parseClientEnvelope({ ...request('host.subscriptions'), session: 'session' })).toThrowError(ProtocolValidationError);
});

it('accepts failed fetches with or without the windows of the last successful fetch', () => {
  const result = { subscriptions: [usage,
    { ...usage, provider: 'codex', modelProvider: 'openai-codex', label: 'Codex Plan', error: { code: 'HTTP_ERROR', httpStatus: 429 } },
    { provider: 'xai', modelProvider: 'xai', label: 'Grok Plan', windows: [], error: { code: 'FETCH_FAILED' } }] };
  expect(parseOperationResult('host.subscriptions', result)).toEqual(result);
  expect(parseOperationResult('host.subscriptions', { subscriptions: [] })).toEqual({ subscriptions: [] });
});

it.each([
  ['a token', { ...usage, token: 'secret' }],
  ['an account ID', { ...usage, accountId: 'account' }],
  ['an endpoint in an error', { ...usage, error: { code: 'HTTP_ERROR', url: 'https://example.test/usage' } }],
  ['a retry hint', { ...usage, error: { code: 'HTTP_ERROR', httpStatus: 429, retryAfterMs: 1_000 } }],
  ['an unknown provider', { ...usage, provider: 'gemini' }],
  ['an unknown error code', { ...usage, error: { code: 'TIMEOUT' } }],
  ['a percentage above 100', { ...usage, windows: [{ label: '5h', usedPercent: 101 }] }],
  ['a negative percentage', { ...usage, windows: [{ label: '5h', usedPercent: -1 }] }],
  ['a description instead of a reset time', { ...usage, windows: [{ label: '5h', usedPercent: 1, resetDescription: 'in 2h' }] }],
  ['a non-ISO reset time', { ...usage, windows: [{ label: '5h', usedPercent: 1, resetAt: 'tomorrow' }] }],
  ['a control character in a label', { ...usage, windows: [{ label: '5h\u001b[2J', usedPercent: 1 }] }],
  ['an oversized label', { ...usage, label: 'x'.repeat(129) }],
  ['too many windows', { ...usage, windows: Array.from({ length: 17 }, () => ({ label: '5h', usedPercent: 1 })) }],
  ['an invalid HTTP status', { ...usage, error: { code: 'HTTP_ERROR', httpStatus: 42 } }],
])('rejects %s', (_name, entry) => {
  expect(() => parseOperationResult('host.subscriptions', { subscriptions: [entry] })).toThrowError(ProtocolValidationError);
});

it('bounds the number of subscriptions', () => {
  expect(() => parseOperationResult('host.subscriptions', { subscriptions: Array.from({ length: 9 }, () => usage) })).toThrowError(ProtocolValidationError);
});
