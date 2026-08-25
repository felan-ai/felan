import { describe, expect, it, vi } from 'vitest';
import { Agent } from 'undici';
import { createPinnedLookup, fetchRemoteUrl, validateRemoteUrl, type SsrfSettings } from '../src/ssrf.js';

const undiciFetch = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => ({
  ...await importOriginal<typeof import('undici')>(),
  fetch: undiciFetch,
}));

const settings: SsrfSettings = {
  allowRanges: [],
  domainPolicy: { allow: [], deny: [] },
};

describe('SSRF protection', () => {
  it('blocks private DNS answers and IPv4-mapped IPv6', async () => {
    await expect(validateRemoteUrl('https://public.example/path', settings, {
      lookup: async () => [{ address: '10.0.0.4', family: 4 }],
    })).rejects.toThrow('Blocked internal address');

    await expect(validateRemoteUrl('https://public.example/path', settings, {
      lookup: async () => [{ address: '::ffff:127.0.0.1', family: 6 }],
    })).rejects.toThrow('Blocked internal address');
  });

  it('revalidates redirect destinations before issuing the next request', async () => {
    const fetchImpl = vi.fn(async () => new Response('', {
      status: 302,
      headers: { location: 'http://127.0.0.1/admin' },
    }));
    await expect(fetchRemoteUrl('https://public.example/start', {}, settings, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl,
    })).rejects.toThrow('Blocked internal address');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('pins validated DNS answers to the connection', async () => {
    const addresses = [{ address: '93.184.216.34', family: 4 }];
    const dispatcher = new Agent();
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(init?.dispatcher).toBe(dispatcher);
      return new Response('ok');
    });
    await fetchRemoteUrl('https://public.example/path', {}, settings, {
      lookup: async () => addresses,
      dispatcherFactory: () => dispatcher,
      fetchImpl,
    });

    const lookup = createPinnedLookup('public.example', addresses);
    await expect(runLookup(lookup, 'public.example')).resolves.toEqual(addresses[0]);
    await expect(runLookup(lookup, 'other.example')).rejects.toThrow('hostname mismatch');
  });

  it('uses the package-matched Undici fetch with the pinned dispatcher', async () => {
    const dispatcher = new Agent();
    undiciFetch.mockResolvedValueOnce(new Response('ok'));

    await fetchRemoteUrl('https://public.example/path', {}, settings, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      dispatcherFactory: () => dispatcher,
    });

    expect(undiciFetch).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'public.example' }),
      expect.objectContaining({ dispatcher, redirect: 'manual' }),
    );
  });

  it('permits only a narrow trusted CIDR exception', async () => {
    await expect(validateRemoteUrl('https://proxy.example', {
      ...settings,
      allowRanges: ['198.18.1.0/24'],
    }, {
      lookup: async () => [{ address: '198.18.1.12', family: 4 }],
    })).resolves.toBeInstanceOf(URL);
    await expect(validateRemoteUrl('https://proxy.example', {
      ...settings,
      allowRanges: ['198.18.1.0/24'],
    }, {
      lookup: async () => [{ address: '198.18.2.12', family: 4 }],
    })).rejects.toThrow('Blocked internal address');
  });
});

function runLookup(lookup: import('node:net').LookupFunction, hostname: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: false }, ((error: Error | null, address: string, family: number) => {
      if (error) reject(error);
      else resolve({ address, family });
    }) as never);
  });
}
