import { describe, expect, it, vi } from 'vitest';
import { createLocalPlatformService } from '../src/providers/platform.js';

describe('optional local Platform provider', () => {
  it('does not create a capability or request anything without a configured identity', () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(createLocalPlatformService({}, fetch)).toBeUndefined();
    expect(createLocalPlatformService({ FELAN_API_KEY: ' ' }, fetch)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps configured credentials private and forwards explicit local endpoints', async () => {
    const key = 'fixture-platform-credential';
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"ok":true}', { status: 200 }));
    const service = createLocalPlatformService({ FELAN_API_KEY: key, FELAN_API_URL: 'https://platform.example.test',
      FELAN_DOCS_URL: 'https://docs.example.test', FELAN_TEAM_SLUG: 'fixture-team' }, fetch)!;
    expect(service.teamSlug).toBe('fixture-team');
    expect(fetch).not.toHaveBeenCalled();
    const response = await service.execute({ method: 'GET', path: 'health' });
    expect(String(fetch.mock.calls[0]![0])).toContain('https://platform.example.test/api/v1/health');
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ Authorization: `Bearer ${key}` });
    expect(JSON.stringify(response)).not.toContain(key);
  });
});
