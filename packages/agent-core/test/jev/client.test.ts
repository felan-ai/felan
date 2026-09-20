import { describe, expect, it, vi } from 'vitest';
import {
  JevClientError,
  createJevClient,
  type JevFetch,
} from '../../src/jev/client.js';
import {
  OPENROUTER_DECISIONS_URL,
  OPENROUTER_MODEL,
  TYPESAFE_MODEL,
  TYPESAFE_SYSTEMONE_URL,
} from '../../src/jev/credentials.js';
import { createJevClassifierWithOptions } from '../../src/jev/classifier.js';
import * as agentCore from '../../src/index.js';

const questions = {
  keep: { type: 'noul' as const, instructions: 'Keep this tool call?' },
};

describe('Jev client', () => {
  it('keeps low-level Jev implementation details out of the root API', () => {
    expect(agentCore.createJevClassifier).toBeTypeOf('function');
    for (const name of [
      'JEV_PROVIDERS',
      'JevClientError',
      'createJevClient',
      'OPENROUTER_DECISIONS_URL',
      'TYPESAFE_SYSTEMONE_URL',
      'resolveJevTransport',
    ]) {
      expect(Object.hasOwn(agentCore, name)).toBe(false);
    }
  });

  it('selects TypeSafe when auto and both keys are present', async () => {
    const fetch = mockFetch({ answers: { keep: { noul: 0.9 } } });
    const client = createJevClient({
      provider: 'auto',
      environment: { TYPESAFE_API_KEY: 'ts-secret', OPENROUTER_API_KEY: 'or-secret' },
      fetch,
    });

    const result = await client.evaluate('state', questions);
    expect(result).toMatchObject({ provider: 'typesafe', model: TYPESAFE_MODEL, answers: { keep: { type: 'noul', noul: 0.9 } } });
    expect(fetch.mock.calls[0]?.[0].href).toBe(TYPESAFE_SYSTEMONE_URL);
    const headers = fetch.mock.calls[0]?.[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ts-secret');
    expect(JSON.stringify(headers)).not.toContain('or-secret');
  });

  it('selects OpenRouter when auto has only that key', async () => {
    const fetch = mockFetch({ answers: { keep: { noul: 0.2 } } });
    const client = createJevClient({
      provider: 'auto',
      environment: { OPENROUTER_API_KEY: 'or-secret' },
      fetch,
    });

    const result = await client.evaluate('state', questions);
    expect(result.provider).toBe('openrouter');
    expect(result.model).toBe(OPENROUTER_MODEL);
    expect(fetch.mock.calls[0]?.[0].href).toBe(OPENROUTER_DECISIONS_URL);
  });

  it('fails closed without credentials', async () => {
    const client = createJevClient({ environment: {}, fetch: mockFetch({ answers: {} }) });
    await expect(client.evaluate('state', questions)).rejects.toMatchObject({
      name: 'JevClientError',
      code: 'unavailable',
    });
  });

  it('redacts credentials from HTTP errors', async () => {
    const fetch = mockFetch({ error: 'Bearer ts-secret leaked' }, { status: 401 });
    const client = createJevClient({
      typesafeApiKey: 'ts-secret',
      fetch,
    });
    await expect(client.evaluate('state', questions)).rejects.toSatisfy((error: unknown) => (
      error instanceof JevClientError
      && error.code === 'http_error'
      && error.message.includes('[redacted]')
      && !error.message.includes('ts-secret')
    ));
  });

  it('rejects malformed answers', async () => {
    const client = createJevClient({
      typesafeApiKey: 'ts-secret',
      fetch: mockFetch({ answers: { keep: { noul: 4 } } }),
    });
    await expect(client.evaluate('state', questions)).rejects.toMatchObject({ code: 'response_invalid' });
  });

  it('treats abort as aborted rather than timeout', async () => {
    const signal = AbortSignal.abort();
    const client = createJevClient({
      typesafeApiKey: 'ts-secret',
      fetch: async () => {
        throw new DOMException('aborted', 'AbortError');
      },
    });
    await expect(client.evaluate('state', questions, { signal })).rejects.toMatchObject({ code: 'aborted' });
  });

  it('keeps Jev credentials sensitive and returns no classifier without keys', async () => {
    expect(createJevClassifierWithOptions({ environment: {} })).toBeUndefined();
    const fetch = mockFetch({ answers: { keep: { choice: 'yes', confidence: 0.8 } } });
    const classifier = createJevClassifierWithOptions({
      typesafeApiKey: 'ts-secret',
      fetch,
    });
    await expect(classifier?.evaluate('state', {
      keep: {
        type: 'choice',
        instructions: 'Keep this tool call?',
        criteria: { yes: 'Keep it', no: 'Discard it' },
      },
    })).resolves.toEqual({
      answers: { keep: { type: 'choice', choice: 'yes', confidence: 0.8 } },
    });
  });
});

function mockFetch(body: unknown, options: { status?: number } = {}): ReturnType<typeof vi.fn<JevFetch>> {
  return vi.fn<JevFetch>(async () => new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  }));
}
