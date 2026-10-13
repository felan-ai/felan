import { FELAN_PLATFORM_SERVICE, createExtensionServiceAccess, createFelanServiceRegistry, type FelanExtensionAPI, type FelanPlatformService } from '@felan-ai/agent-core';
import { afterEach, expect, it, vi } from 'vitest';
import extension from '../src/extension.js';
import { createFelanPlatformService, type FelanPlatformOptions } from '../src/service.js';

afterEach(() => vi.unstubAllEnvs());

function harness() {
  const services = createFelanServiceRegistry(); const registerTool = vi.fn(); const registerCapability = vi.fn();
  const pi = { services: createExtensionServiceAccess(services, extension.serviceRequirements!), registerTool, registerCapability } as unknown as FelanExtensionAPI;
  return { services, pi, registerTool, registerCapability };
}

it('does not discover ambient credentials or hosts without the optional Platform service', () => {
  vi.stubEnv('FELAN_API_KEY', 'ambient-key'); vi.stubEnv('FELAN_API_URL', 'https://ambient.invalid'); vi.stubEnv('FELAN_TEAM_SLUG', 'ambient-team');
  const h = harness(); extension(h.pi);
  expect(extension.serviceRequirements).toEqual({ optional: [FELAN_PLATFORM_SERVICE] });
  expect(h.registerTool).not.toHaveBeenCalled(); expect(h.registerCapability).not.toHaveBeenCalled();
});

it('registers one gateway from a fake service and forwards exact requests and cancellation', async () => {
  vi.stubEnv('FELAN_TEAM_SLUG', 'ambient-team');
  const h = harness();
  const result = { content: [{ type: 'text' as const, text: 'bounded fixture' }], details: { method: 'GET' as const, path: '/api/v1/openapi.json', ok: true, truncated: false } };
  const execute = vi.fn<FelanPlatformService['execute']>(async () => result);
  h.services.set(FELAN_PLATFORM_SERVICE, { execute }); extension(h.pi);
  expect(h.registerTool).toHaveBeenCalledOnce(); expect(h.registerCapability).toHaveBeenCalledOnce();
  expect(h.registerCapability.mock.calls[0]![0].instructions).not.toContain('ambient-team');
  const signal = new AbortController().signal;
  const params = { path: 'openapi.json', method: 'GET', target: 'api', query: { enabled: true } };
  expect(await h.registerTool.mock.calls[0]![0].execute('call', params, signal)).toBe(result);
  expect(execute).toHaveBeenCalledWith(params, signal);
});

it('validates service-provided team guidance before registering capabilities', () => {
  const h = harness(); h.services.set(FELAN_PLATFORM_SERVICE, { teamSlug: 'bad/slug', execute: vi.fn() });
  expect(() => extension(h.pi)).toThrow('Felan API team slug is invalid'); expect(h.registerTool).not.toHaveBeenCalled();
});

it('offers a bounded explicit provider implementation without environment fallback', async () => {
  vi.stubEnv('FELAN_API_KEY', 'ambient-key'); vi.stubEnv('FELAN_API_URL', 'https://ambient.invalid');
  const fetch = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }));
  const options: FelanPlatformOptions = { apiKey: 'explicit-key', baseUrl: 'https://fixture.test', docsBaseUrl: 'https://docs.test', fetch };
  const service = createFelanPlatformService(options);
  const result = await service.execute({ path: 'openapi.json' });
  expect(result.details.ok).toBe(true); expect(result.content[0]?.text).toContain('<untrusted_felan_api_content');
  expect(String(fetch.mock.calls[0]![0])).toBe('https://fixture.test/api/v1/openapi.json');
  expect(fetch.mock.calls[0]![1]?.headers).toMatchObject({ Authorization: 'Bearer explicit-key' });
  for (const key of ['apiKey', 'baseUrl', 'docsBaseUrl'] as const) {
    expect(() => createFelanPlatformService({ ...options, [key]: ' ' })).toThrow(`requires an explicit ${key}`);
  }
  expect(() => createFelanPlatformService({ ...options, fetch: undefined } as unknown as FelanPlatformOptions)).toThrow('requires an explicit fetch');
});
