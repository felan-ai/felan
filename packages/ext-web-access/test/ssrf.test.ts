import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from 'undici';
import { createPinnedLookup, fetchRemoteUrl, validateRemoteUrl, type SsrfSettings } from '../src/ssrf.js';

const undiciFetch = vi.hoisted(() => vi.fn());
const agentOptions = vi.hoisted(() => [] as Array<{ connect?: { lookup?: import('node:net').LookupFunction } } | undefined>);
vi.mock('undici', async (importOriginal) => {
  const original = await importOriginal<typeof import('undici')>();
  return {
    ...original,
    Agent: class MockAgent {
      constructor(options?: { connect?: { lookup?: import('node:net').LookupFunction } }) {
        agentOptions.push(options);
      }

      async close(): Promise<void> {}
      async destroy(): Promise<void> {}
    },
    fetch: undiciFetch,
  };
});

const settings: SsrfSettings = {
  allowRanges: [],
  domainPolicy: { allow: [], deny: [] },
};

describe('SSRF protection', () => {
  beforeEach(() => {
    agentOptions.length = 0;
    undiciFetch.mockReset();
  });

  it('enforces domain allow and deny policies before DNS resolution', async () => {
    const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);

    await expect(validateRemoteUrl('https://blocked.example/path', {
      ...settings,
      domainPolicy: { allow: [], deny: ['blocked.example'] },
    }, { lookup })).rejects.toThrow('Blocked hostname by fetch_content domain policy: blocked.example');
    await expect(validateRemoteUrl('https://outside.example/path', {
      ...settings,
      domainPolicy: { allow: ['approved.example'], deny: [] },
    }, { lookup })).rejects.toThrow('Hostname not allowed by fetch_content domain policy: outside.example');
    await expect(validateRemoteUrl('https://docs.approved.example/path', {
      ...settings,
      domainPolicy: { allow: ['approved.example'], deny: [] },
    }, { lookup })).resolves.toBeInstanceOf(URL);
    expect(lookup).toHaveBeenCalledOnce();
  });

  it('blocks localhost, every private DNS answer, and IPv4-mapped IPv6', async () => {
    const localhostLookup = vi.fn();
    await expect(validateRemoteUrl('https://api.localhost/path', settings, {
      lookup: localhostLookup,
    })).rejects.toThrow('Blocked internal hostname');
    expect(localhostLookup).not.toHaveBeenCalled();

    await expect(validateRemoteUrl('https://public.example/path', settings, {
      lookup: async () => [{ address: '10.0.0.4', family: 4 }],
    })).rejects.toThrow('Blocked internal address');

    await expect(validateRemoteUrl('https://public.example/path', settings, {
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '192.168.1.10', family: 4 },
      ],
    })).rejects.toThrow('Blocked internal address');

    await expect(validateRemoteUrl('https://public.example/path', settings, {
      lookup: async () => [{ address: '::ffff:127.0.0.1', family: 6 }],
    })).rejects.toThrow('Blocked internal address');
  });

  it.each([
    'http://127.0.0.1/',
    'http://169.254.10.20/',
    'http://10.0.0.1/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[64:ff9b:1::1]/',
  ])('rejects direct private, loopback, link-local, mapped, and NAT64 address %s', async (url) => {
    const lookup = vi.fn();
    await expect(validateRemoteUrl(url, settings, { lookup })).rejects.toThrow('Blocked internal address');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('re-resolves and rejects private DNS answers at redirect destinations', async () => {
    const lookup = vi.fn(async (hostname: string) => hostname === 'public.example'
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '10.0.0.4', family: 4 }]);
    const fetchImpl = vi.fn(async () => new Response('', {
      status: 302,
      headers: { location: 'https://redirected.example/admin' },
    }));
    await expect(fetchRemoteUrl('https://public.example/start', {}, settings, {
      lookup,
      fetchImpl,
    })).rejects.toThrow('Blocked internal address');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenNthCalledWith(1, 'public.example');
    expect(lookup).toHaveBeenNthCalledWith(2, 'redirected.example');
  });

  it('strips credentials from cross-origin redirects when they are permitted', async () => {
    const dispatcher = new Agent();
    const fetchImpl = vi.fn(async (_url, init) => fetchImpl.mock.calls.length === 1
      ? new Response('', { status: 302, headers: { location: 'https://redirected.example/result' } })
      : new Response('ok'));

    await fetchRemoteUrl('https://public.example/start', {
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'session=secret',
        'Proxy-Authorization': 'Basic secret',
        'X-API-Key': 'secret',
        'X-Subscription-Token': 'secret',
        'ChatGPT-Account-Id': 'secret',
        'CF-Access-Client-Secret': 'secret',
        Accept: 'application/json',
      },
    }, settings, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      dispatcherFactory: () => dispatcher,
      fetchImpl,
    });

    const redirectedHeaders = new Headers(fetchImpl.mock.calls[1]?.[1]?.headers);
    expect(redirectedHeaders.get('accept')).toBe('application/json');
    expect(redirectedHeaders.has('authorization')).toBe(false);
    expect(redirectedHeaders.has('cookie')).toBe(false);
    expect(redirectedHeaders.has('proxy-authorization')).toBe(false);
    expect(redirectedHeaders.has('x-api-key')).toBe(false);
    expect(redirectedHeaders.has('x-subscription-token')).toBe(false);
    expect(redirectedHeaders.has('chatgpt-account-id')).toBe(false);
    expect(redirectedHeaders.has('cf-access-client-secret')).toBe(false);
  });

  it('bounds redirect loops and revalidates every hop', async () => {
    const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
    const fetchImpl = vi.fn(async () => new Response('', {
      status: 302,
      headers: { location: '/again' },
    }));

    await expect(fetchRemoteUrl('https://public.example/start', {}, settings, {
      lookup,
      fetchImpl,
      maxRedirects: 2,
    })).rejects.toThrow('Too many redirects');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('propagates a caller abort while waiting for response headers', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled request');
    const fetchImpl = vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const request = fetchRemoteUrl('https://public.example/start', {
      signal: controller.signal,
    }, settings, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
  });

  it('propagates cancellation while DNS resolution is still pending', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled DNS');
    const lookup = vi.fn(async () => new Promise<never>(() => undefined));
    const validation = validateRemoteUrl('https://public.example/start', settings, {
      lookup,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());

    controller.abort(reason);

    await expect(validation).rejects.toBe(reason);
  });

  it('reapplies domain policy at redirect destinations', async () => {
    const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
    const fetchImpl = vi.fn(async () => new Response('', {
      status: 302,
      headers: { location: 'https://outside.example/admin' },
    }));

    await expect(fetchRemoteUrl('https://public.example/start', {}, {
      ...settings,
      domainPolicy: { allow: ['public.example'], deny: [] },
    }, { lookup, fetchImpl })).rejects.toThrow('Hostname not allowed by fetch_content domain policy: outside.example');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledOnce();
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

  it('builds the default dispatcher from the validated DNS answers', async () => {
    const addresses = [{ address: '93.184.216.34', family: 4 }];
    undiciFetch.mockImplementationOnce(async (_url, init) => {
      const lookup = agentOptions.at(-1)?.connect?.lookup;
      expect(lookup).toBeTypeOf('function');
      await expect(runLookup(lookup!, 'public.example')).resolves.toEqual(addresses[0]);
      await expect(runLookup(lookup!, 'other.example')).rejects.toThrow('hostname mismatch');
      return new Response('ok');
    });

    await fetchRemoteUrl('https://public.example/path', {}, settings, {
      lookup: async () => addresses,
    });
    expect(undiciFetch).toHaveBeenCalledOnce();
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
