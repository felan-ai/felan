import { expect, it } from 'vitest';
import { parseOperationResult, parseSchema, SetupStartSchema } from '../src/index.js';

it('exposes method availability and display metadata without credential values', () => {
  const catalog = { providers: [{ id: 'provider', label: 'Provider', configured: true,
    methods: ['oauth', 'api_key'], subscription: true, apiKeyLogin: false, apiKeyName: 'Ambient credentials',
    oauthLabel: 'Use subscription', status: { type: 'oauth', source: 'OAuth' } }],
  credentials: [{ id: 'provider', label: 'Provider', type: 'oauth', subscription: true }], dependencies: [] };
  expect(parseOperationResult('host.setup.catalog', catalog)).toEqual(catalog);
  expect(() => parseOperationResult('host.setup.catalog', { ...catalog, providers: [{ ...catalog.providers[0], apiKey: 'secret' }] })).toThrow();
  expect(() => parseOperationResult('host.setup.catalog', { ...catalog, credentials: [{ ...catalog.credentials[0], refreshToken: 'secret' }] })).toThrow();
});

it('requires explicit confirmation for stored-credential removal', () => {
  expect(parseSchema(SetupStartSchema, { kind: 'logout', provider: 'provider', confirmed: true })).toEqual({ kind: 'logout', provider: 'provider', confirmed: true });
  expect(() => parseSchema(SetupStartSchema, { kind: 'logout', provider: 'provider', confirmed: false })).toThrow();
  expect(parseOperationResult('host.setup.start', { id: 'job', kind: 'logout', state: 'running', message: 'Removing credentials' }).kind).toBe('logout');
});
