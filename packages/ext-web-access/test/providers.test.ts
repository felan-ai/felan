import type { AgentRuntime } from '@felan-ai/agent-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchProviders, type ProviderEnvironment } from '../src/providers.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

describe('search providers and routing', () => {
  const saved = {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    BRAVE_API_KEY: process.env.BRAVE_API_KEY,
    EXA_API_KEY: process.env.EXA_API_KEY,
  };

  beforeEach(() => {
    process.env.HTTPS_PROXY = 'http://proxy.example:8080';
    process.env.NO_PROXY = '';
    delete process.env.OPENAI_API_KEY;
    delete process.env.BRAVE_API_KEY;
    delete process.env.EXA_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('prefers configured SearXNG first in auto mode', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => jsonResponse({
      answers: ['local answer'],
      results: [{ title: 'Local', url: 'https://content.example/a', content: 'local result' }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await searchProviders('query', 'auto', { numResults: 5 }, environment({
      searxngBaseUrl: 'https://search.internal.example',
      fetchContent: { domainPolicy: { allow: ['content.example'] } },
    }));

    expect(result.responses.map((response) => response.provider)).toEqual(['searxng']);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('https://search.internal.example/search');
  });

  it('reuses Pi OpenAI-Codex auth before config or environment credentials', async () => {
    const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true as const, apiKey: codexToken(), headers: { 'x-pi-auth': 'yes' } }));
    const fetchMock = vi.fn(async (_input: string | URL | Request) => jsonResponse({
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: 'OpenAI answer',
          annotations: [{ type: 'url_citation', title: 'Source', url: 'https://content.example/openai' }],
        }],
      }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const env = environment({ openaiApiKey: '!should-not-run' }, {
      getAll: () => [{ provider: 'openai-codex', id: 'gpt-5.6-terra', baseUrl: 'https://chatgpt.com/backend-api/codex' }],
      hasConfiguredAuth: () => true,
      getApiKeyAndHeaders,
    });
    const result = await searchProviders('query', 'openai', { numResults: 5 }, env);

    expect(result.responses[0]?.provider).toBe('openai');
    expect(getApiKeyAndHeaders).toHaveBeenCalledOnce();
    expect(env.runtime.exec).not.toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://chatgpt.com/backend-api/codex/responses');
  });

  it('does not reuse registry credentials from an overridden OpenAI endpoint', async () => {
    const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true as const, apiKey: 'proxy-key', headers: {} }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = environment({}, {
      getAll: () => [{ provider: 'openai', id: 'proxy-model', baseUrl: 'https://proxy.example/v1' }],
      hasConfiguredAuth: () => true,
      getApiKeyAndHeaders,
    });

    await expect(searchProviders('query', 'openai', { numResults: 5 }, env))
      .rejects.toThrow('openai search provider is not configured');
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('supports direct Exa and Brave credentials', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://api.exa.ai/answer')) {
        return jsonResponse({ answer: 'Exa direct', citations: [{ title: 'Exa', url: 'https://content.example/exa' }] });
      }
      if (url.startsWith('https://api.search.brave.com/')) {
        return jsonResponse({ web: { results: [{ title: 'Brave', url: 'https://content.example/brave', description: 'Brave direct' }] } });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = environment({ exaApiKey: 'exa-key', braveApiKey: 'brave-key' });

    const [exa, brave] = await Promise.all([
      searchProviders('query', 'exa', { numResults: 5 }, env),
      searchProviders('query', 'brave', { numResults: 5 }, env),
    ]);
    expect(exa.responses[0]?.answer).toBe('Exa direct');
    expect(brave.responses[0]?.results[0]?.title).toBe('Brave');
  });

  it('keeps unavailable named providers strict', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(searchProviders('query', 'brave', { numResults: 5 }, environment({}))).rejects.toThrow('brave search provider is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs exactly the providers in a non-empty explicit array', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://search.example/search')) return jsonResponse({ results: [] });
      if (url.startsWith('https://mcp.exa.ai/mcp')) return jsonResponse({
        result: { content: [{ type: 'text', text: 'Title: Exa\nURL: https://content.example/exa\nText: result\n---' }] },
      });
      throw new Error(`Unexpected URL ${url}`);
    }));
    const result = await searchProviders('query', ['exa', 'searxng'], { numResults: 5 }, environment({ searxngBaseUrl: 'https://search.example' }));
    expect(result.responses.map((response) => response.provider).sort()).toEqual(['exa', 'searxng']);
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
