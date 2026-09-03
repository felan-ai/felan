import { resolveExtensionConfigs } from '@felan-ai/agent-core';
import { describe, expect, it } from 'vitest';
import {
  configuredProvider,
  pdfSettings,
  webAccessConfigFromSettings,
  WEB_ACCESS_CONFIG,
} from '../src/config.js';
import { ssrfSettings } from '../src/ssrf.js';

describe('web access PDF configuration', () => {
  it('publishes the complete current configuration surface and sensitive flags', () => {
    expect(Object.keys(WEB_ACCESS_CONFIG.fields)).toEqual([
      'provider',
      'searchProvider',
      'openaiApiKey',
      'openaiSearchModel',
      'exaApiKey',
      'braveApiKey',
      'searxngBaseUrl',
      'searxngHeaders',
      'pdf',
      'fetchContent',
      'ssrf',
    ]);
    expect(WEB_ACCESS_CONFIG.fields.openaiApiKey?.sensitive).toBe(true);
    expect(WEB_ACCESS_CONFIG.fields.exaApiKey?.sensitive).toBe(true);
    expect(WEB_ACCESS_CONFIG.fields.braveApiKey?.sensitive).toBe(true);
    expect(WEB_ACCESS_CONFIG.fields.searxngHeaders?.sensitive).toBe(true);
    expect(WEB_ACCESS_CONFIG.fields).not.toHaveProperty('githubClone');
  });

  it('uses bounded defaults and forwards configured PDF limits', () => {
    expect(pdfSettings({})).toEqual({
      maximumBytes: 20 * 1024 * 1024,
    });
    const config = webAccessConfigFromSettings({ pdf: { maxSizeMB: 2.5 } });
    expect(pdfSettings(config)).toEqual({
      maximumBytes: 2.5 * 1024 * 1024,
    });
  });

  it('rejects invalid or excessive PDF limits at runtime', () => {
    expect(() => pdfSettings({ pdf: { maxSizeMB: 21 } })).toThrow('maxSizeMB');
  });

  it('validates PDF settings at the declarative configuration boundary', () => {
    expect(() => resolveExtensionConfigs([WEB_ACCESS_CONFIG], [{
      extensionId: 'webAccess',
      values: { pdf: { maxSizeMB: 21 } },
      source: 'test',
    }])).toThrow('maxSizeMB must be a number greater than 0 and at most 20');
    expect(() => resolveExtensionConfigs([WEB_ACCESS_CONFIG], [{
      extensionId: 'webAccess',
      values: { pdf: { unexpected: true } },
      source: 'test',
    }])).toThrow('contains unknown field: unexpected');
  });

  it('rejects invalid providers, endpoints, and headers declaratively', () => {
    expectConfigError({ provider: 'unknown' }, 'provider must be auto');
    expectConfigError({ searxngBaseUrl: 'file:///etc/passwd' }, 'must be an HTTP(S) URL');
    expectConfigError({ searxngHeaders: { 'bad header': 'value' } }, 'contains an invalid header');
    expectConfigError({ searxngHeaders: { Authorization: 42 } }, 'contains an invalid header');
  });

  it('rejects invalid domain and allow-range configuration declaratively and at runtime', () => {
    expectConfigError({ fetchContent: { unknown: true } }, 'contains unknown field: unknown');
    expectConfigError({ fetchContent: { domainPolicy: { allow: ['bad host'] } } }, 'contains an invalid hostname');
    expectConfigError({ ssrf: { unknown: [] } }, 'contains unknown field: unknown');
    expectConfigError({ ssrf: { allowRanges: ['127.0.0.1/99'] } }, 'contains an invalid CIDR');

    expect(() => configuredProvider({ provider: 'unknown' })).toThrow('configured provider must be auto');
    expect(() => ssrfSettings({ fetchContent: { domainPolicy: { deny: ['bad host'] } } }))
      .toThrow('contains an invalid hostname');
    expect(() => ssrfSettings({ ssrf: { allowRanges: ['127.0.0.1/99'] } }))
      .toThrow('Invalid CIDR in ssrf.allowRanges');
  });
});

function expectConfigError(values: Record<string, unknown>, message: string): void {
  expect(() => resolveExtensionConfigs([WEB_ACCESS_CONFIG], [{
    extensionId: 'webAccess',
    values,
    source: 'test',
  }])).toThrow(message);
}
