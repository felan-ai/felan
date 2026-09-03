import type { AgentRuntime } from '@felan-ai/agent-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchProviders, type ProviderEnvironment } from '../src/providers.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));
vi.mock('undici', async (importOriginal) => ({
  ...await importOriginal<typeof import('undici')>(),
  fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
}));

describe('bounded search providers and routing', () => {
  const saved = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    BRAVE_API_KEY: process.env.BRAVE_API_KEY,
    EXA_API_KEY: process.env.EXA_API_KEY,
    SEARXNG_BASE_URL: process.env.SEARXNG_BASE_URL,
  };

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.BRAVE_API_KEY;
    delete process.env.EXA_API_KEY;
    delete process.env.SEARXNG_BASE_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('prefers configured SearXNG in auto mode and falls back to public Exa MCP after failure', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://search.example/search')) return new Response('', { status: 503 });
      if (url.startsWith('https://mcp.exa.ai/mcp')) return jsonResponse({
        result: {
          content: [{
            type: 'text',
            text: 'Title: Exa result\nURL: https://result.example/exa\nText:\nexa snippet\n---',
          }],
        },
      });
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchProviders('query', 'auto', { numResults: 5 }, environment({
      searxngBaseUrl: 'https://search.example',
    }));

    expect(result.responses).toEqual([{
      provider: 'exa',
      results: [{ title: 'Exa result', url: 'https://result.example/exa', snippet: 'exa snippet' }],
    }]);
    expect(result.errors).toEqual([{ provider: 'searxng', error: 'SearXNG search request failed with HTTP 503' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('routes direct OpenAI Codex auth only from an official endpoint', async () => {
    const getApiKeyAndHeaders = vi.fn(async () => ({
      ok: true as const,
      apiKey: codexToken(),
      headers: { 'x-pi-auth': 'yes', 'x-pi-removed': null },
    }));
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: 'answer',
          annotations: [{ type: 'url_citation', title: 'Source', url: 'https://result.example/openai' }],
        }],
      }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const env = environment({}, {
      getAll: () => [{ provider: 'openai-codex', id: 'gpt-5.6-terra', baseUrl: 'https://chatgpt.com/backend-api' }],
      hasConfiguredAuth: () => true,
      getApiKeyAndHeaders,
    });

    const result = await searchProviders('query', 'openai', { numResults: 5 }, env);

    expect(result.responses[0]?.results[0]?.url).toBe('https://result.example/openai');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('x-pi-auth')).toBe('yes');

    const overridden = environment({}, {
      getAll: () => [{ provider: 'openai', id: 'proxy-model', baseUrl: 'https://proxy.example/v1' }],
      hasConfiguredAuth: () => true,
      getApiKeyAndHeaders,
    });
    await expect(searchProviders('query', 'openai', { numResults: 5 }, overridden))
      .rejects.toThrow('openai search provider is not configured');
  });

  it('routes direct Exa and Brave credentials to their pinned endpoints', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.exa.ai/search') return jsonResponse({
        results: [{ title: 'Exa', url: 'https://result.example/exa', highlights: ['exa direct'] }],
      });
      if (url.startsWith('https://api.search.brave.com/res/v1/web/search')) return jsonResponse({
        web: { results: [{ title: 'Brave', url: 'https://result.example/brave', description: 'brave direct' }] },
      });
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = environment({ exaApiKey: 'exa-key', braveApiKey: 'brave-key' });

    const [exa, brave] = await Promise.all([
      searchProviders('query', 'exa', { numResults: 5 }, env),
      searchProviders('query', 'brave', { numResults: 5 }, env),
    ]);

    expect(exa.responses[0]?.results[0]).toMatchObject({ title: 'Exa', snippet: 'exa direct' });
    expect(brave.responses[0]?.results[0]).toMatchObject({ title: 'Brave', snippet: 'brave direct' });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('x-api-key')).toBe('exa-key');
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('x-subscription-token')).toBe('brave-key');
  });

  it('keeps named providers strict and reports unavailable explicit-array providers as partial errors', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      results: [{ title: 'SearXNG', url: 'https://result.example/searxng', content: 'result' }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const env = environment({ searxngBaseUrl: 'https://search.example' });

    await expect(searchProviders('query', 'brave', { numResults: 5 }, env))
      .rejects.toThrow('brave search provider is not configured');
    const result = await searchProviders('query', ['searxng', 'brave'], { numResults: 5 }, env);
    expect(result.responses.map((response) => response.provider)).toEqual(['searxng']);
    expect(result.errors).toEqual([{ provider: 'brave', error: 'brave search provider is not configured' }]);
  });

  it('searches every available provider in all mode and preserves provider attribution', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://search.example/search')) return jsonResponse({
        results: [{ title: 'SearXNG', url: 'https://result.example/searxng', content: 'one' }],
      });
      if (url === 'https://api.exa.ai/search') return jsonResponse({
        results: [{ title: 'Exa', url: 'https://result.example/exa', highlights: ['two'] }],
      });
      if (url.startsWith('https://api.search.brave.com/')) return jsonResponse({
        web: { results: [{ title: 'Brave', url: 'https://result.example/brave', description: 'three' }] },
      });
      throw new Error('unexpected provider endpoint');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchProviders('query', 'all', { numResults: 5 }, environment({
      searxngBaseUrl: 'https://search.example',
      exaApiKey: 'exa-key',
      braveApiKey: 'brave-key',
    }));

    expect(result.errors).toEqual([]);
    expect(result.responses.map((response) => response.provider)).toEqual(['searxng', 'exa', 'brave']);
    expect(result.responses.flatMap((response) => response.results).map((item) => item.url)).toEqual([
      'https://result.example/searxng',
      'https://result.example/exa',
      'https://result.example/brave',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid SearXNG endpoint and header configuration at runtime', async () => {
    await expect(searchProviders('query', 'searxng', { numResults: 5 }, environment({
      searxngBaseUrl: 'file:///etc/passwd',
    }))).rejects.toThrow('searxng search provider is not configured');

    const result = await searchProviders('query', 'searxng', { numResults: 5 }, environment({
      searxngBaseUrl: 'https://search.example',
      searxngHeaders: { 'bad header': 'value' },
    }));
    expect(result.responses).toEqual([]);
    expect(result.errors[0]?.error).toContain('Invalid SearXNG header');
    expect(result.errors[0]?.error).not.toContain('value');
  });

  it('validates and canonically deduplicates result URLs before returning them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      results: [
        { title: 'First', url: 'HTTPS://RESULT.EXAMPLE:443/path#one', content: 'first' },
        { title: 'Duplicate', url: 'https://result.example/path#two', content: 'second' },
        { title: 'Credentials', url: 'https://user:secret@result.example/private', content: 'private' },
        { title: 'JavaScript', url: 'javascript:alert(1)', content: 'unsafe' },
        { title: 'Malformed', url: 'not a url', content: 'invalid' },
      ],
    })));

    const result = await searchProviders('query', 'searxng', { numResults: 10 }, environment({
      searxngBaseUrl: 'https://search.example',
    }));

    expect(result.responses[0]?.results).toEqual([{
      title: 'First',
      url: 'https://result.example/path',
      snippet: 'first',
    }]);
  });

  it('redacts configured headers and query text from bounded provider errors', async () => {
    const secret = 'searx-secret-header';
    const query = 'private search query';
    const environmentSecret = 'environment credential';
    process.env.BRAVE_API_KEY = environmentSecret;
    const formQuery = new URLSearchParams([['value', query]]).toString().slice('value='.length);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', {
      status: 302,
      headers: {
        location: `https://search.example/again?token=${secret}&q=${encodeURIComponent(query)}&form=${formQuery}&credential=${encodeURIComponent(environmentSecret)}`,
      },
    })));

    const result = await searchProviders(query, 'searxng', { numResults: 5 }, environment({
      searxngBaseUrl: 'https://search.example',
      searxngHeaders: { Authorization: secret },
    }));

    expect(result.responses).toEqual([]);
    expect(result.errors[0]?.error).toContain('[redacted]');
    expect(result.errors[0]?.error).not.toContain(secret);
    expect(result.errors[0]?.error).not.toContain(query);
    expect(result.errors[0]?.error).not.toContain(formQuery);
    expect(result.errors[0]?.error).not.toContain(encodeURIComponent(environmentSecret));
    expect(result.errors[0]?.error.length).toBeLessThanOrEqual(240);
  });

  it('bounds provider response bodies before parsing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))));

    const result = await searchProviders('query', 'searxng', { numResults: 5 }, environment({
      searxngBaseUrl: 'https://search.example',
    }));

    expect(result.responses).toEqual([]);
    expect(result.errors[0]?.error).toBe(`Response exceeds the ${2 * 1024 * 1024}-byte limit`);
  });
});

function environment(config: Record<string, unknown>, registry: Record<string, unknown> = {}): ProviderEnvironment {
  const runtime = {
    kind: 'host',
    cwd: '/workspace',
    exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
  } as unknown as AgentRuntime;
  return {
    config,
    runtime,
    ctx: {
      modelRegistry: {
        getAll: () => [],
        hasConfiguredAuth: () => false,
        getApiKeyAndHeaders: vi.fn(),
        ...registry,
      },
    } as any,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

function codexToken(): string {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' },
  })).toString('base64url');
  return `header.${payload}.signature`;
}
