import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSupportedThinkingLevels, ModelRuntime, type Model, type SimpleStreamOptions } from '@felan-ai/agent-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDiscreteStackProvider } from '../src/index.js';
import {
  DISCRETESTACK_API_KEY_ENV,
  DISCRETESTACK_BASE_URLS,
  DISCRETESTACK_KEY_TYPE_ENV,
  DISCRETESTACK_PROVIDER_ID,
} from '../src/provider.js';

const envKey = 'test-environment-value';
const storedKey = 'test-stored-value';
const maxModel = 'discretestack-max';
const compactModel = 'discretestack-compact';

async function createRuntime(authPath: string) {
  const modelRuntime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(createDiscreteStackProvider());
  return modelRuntime;
}

function requireModel(runtime: ModelRuntime, modelId: string): Model<'openai-completions'> {
  const model = runtime.getModel(DISCRETESTACK_PROVIDER_ID, modelId);
  if (!model) throw new Error(`Model not registered: ${modelId}`);
  return model as Model<'openai-completions'>;
}

function stubChatCompletion() {
  const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const chunk = { choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function sendChat(runtime: ModelRuntime, model: Model<'openai-completions'>, options: SimpleStreamOptions = {}) {
  const fetchMock = stubChatCompletion();
  const result = await runtime.streamSimple(model, {
    messages: [{ role: 'user', content: 'Say OK', timestamp: 0 }],
  }, { maxTokens: 32, maxRetries: 0, ...options }).result();
  expect(result.stopReason).toBe('stop');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const call = fetchMock.mock.calls[0];
  if (!call) throw new Error('No chat completion request captured');
  return new Request(...call);
}

describe('DiscreteStack in the Pi model runtime', () => {
  let tempDir: string;
  let authPath: string;

  beforeEach(async () => {
    vi.stubEnv('PI_OFFLINE', '1');
    vi.stubEnv(DISCRETESTACK_API_KEY_ENV, undefined);
    vi.stubEnv(DISCRETESTACK_KEY_TYPE_ENV, undefined);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request'); }));
    tempDir = await mkdtemp(join(tmpdir(), 'felan-discretestack-'));
    authPath = join(tempDir, 'auth.json');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('resolves both chat models with their limits, prices, and thinking levels', async () => {
    const runtime = await createRuntime(authPath);
    const models = runtime.getModels(DISCRETESTACK_PROVIDER_ID);
    expect(models).toMatchObject([
      {
        id: maxModel,
        name: 'DiscreteStack Max',
        cost: { input: 0.07, output: 0.18, cacheRead: 0.002, cacheWrite: 0 },
      },
      {
        id: compactModel,
        name: 'DiscreteStack Compact',
        cost: { input: 0.05, output: 0.2, cacheRead: 0.015, cacheWrite: 0 },
      },
    ]);
    for (const model of models) {
      expect(model).toMatchObject({
        provider: DISCRETESTACK_PROVIDER_ID,
        api: 'openai-completions',
        baseUrl: DISCRETESTACK_BASE_URLS.user,
        reasoning: true,
        input: ['text', 'image'],
        maxTokens: 64000,
        contextWindow: 984576,
        thinkingLevelMap: { off: 'none', minimal: 'none', low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          maxTokensField: 'max_tokens',
        },
      });
      // The gateway answers 413 when prompt plus max_tokens exceeds 1,048,576 tokens.
      expect(model.contextWindow + model.maxTokens).toBe(1048576);
      expect(model.compat).not.toHaveProperty('thinkingFormat');
      expect(getSupportedThinkingLevels(model)).toEqual(['off', 'minimal', 'low', 'high', 'max']);
    }
  });

  it('uses the environment key as a personal key only when it is configured', async () => {
    const runtime = await createRuntime(authPath);
    expect(runtime.getProviderAuthStatus(DISCRETESTACK_PROVIDER_ID)).toEqual({ configured: false });
    expect(await runtime.checkAuth(DISCRETESTACK_PROVIDER_ID)).toBeUndefined();
    expect(await runtime.getAuth(DISCRETESTACK_PROVIDER_ID)).toBeUndefined();

    vi.stubEnv(DISCRETESTACK_API_KEY_ENV, envKey);
    await runtime.refresh({ allowNetwork: false, providers: [DISCRETESTACK_PROVIDER_ID] });
    expect(runtime.getProviderAuthStatus(DISCRETESTACK_PROVIDER_ID)).toEqual({
      configured: true,
      source: 'environment',
      label: DISCRETESTACK_API_KEY_ENV,
    });
    expect((await runtime.getAuth(DISCRETESTACK_PROVIDER_ID))?.auth).toEqual({
      apiKey: envKey,
      baseUrl: DISCRETESTACK_BASE_URLS.user,
    });
  });

  it('routes an environment key marked as a provider key to the provider channel', async () => {
    vi.stubEnv(DISCRETESTACK_API_KEY_ENV, envKey);
    vi.stubEnv(DISCRETESTACK_KEY_TYPE_ENV, 'provider');
    const runtime = await createRuntime(authPath);
    expect((await runtime.getAuth(DISCRETESTACK_PROVIDER_ID))?.auth).toEqual({
      apiKey: envKey,
      baseUrl: DISCRETESTACK_BASE_URLS.provider,
    });
  });

  it('logs in with a personal key that wins over the environment and ignores its key type', async () => {
    const runtime = await createRuntime(authPath);
    const provider = runtime.getProviders().find(({ id }) => id === DISCRETESTACK_PROVIDER_ID);
    expect(provider?.name).toBe('DiscreteStack');
    expect(provider?.auth.apiKey?.login).toBeTypeOf('function');

    const prompt = vi.fn(async () => storedKey);
    await runtime.login(DISCRETESTACK_PROVIDER_ID, 'api_key', { prompt, notify: vi.fn() });
    expect(prompt).toHaveBeenCalledExactlyOnceWith({ type: 'secret', message: 'Enter your DiscreteStack API key' });

    vi.stubEnv(DISCRETESTACK_API_KEY_ENV, envKey);
    vi.stubEnv(DISCRETESTACK_KEY_TYPE_ENV, 'provider');
    const reopened = await createRuntime(authPath);
    await reopened.refresh({ allowNetwork: false, providers: [DISCRETESTACK_PROVIDER_ID] });
    expect(reopened.getProviderAuthStatus(DISCRETESTACK_PROVIDER_ID)).toEqual({ configured: true, source: 'stored' });
    expect((await reopened.getAuth(DISCRETESTACK_PROVIDER_ID))?.auth).toEqual({
      apiKey: storedKey,
      baseUrl: DISCRETESTACK_BASE_URLS.user,
    });
  });

  it('routes a stored credential marked as a provider key to the provider channel', async () => {
    await writeFile(authPath, JSON.stringify({
      [DISCRETESTACK_PROVIDER_ID]: { type: 'api_key', key: storedKey, env: { [DISCRETESTACK_KEY_TYPE_ENV]: 'provider' } },
    }));
    const runtime = await createRuntime(authPath);
    expect((await runtime.getAuth(DISCRETESTACK_PROVIDER_ID))?.auth).toEqual({
      apiKey: storedKey,
      baseUrl: DISCRETESTACK_BASE_URLS.provider,
    });
  });

  it('treats a runtime key as a personal key even when the environment marks provider keys', async () => {
    vi.stubEnv(DISCRETESTACK_KEY_TYPE_ENV, 'provider');
    const runtime = await createRuntime(authPath);
    await runtime.setRuntimeApiKey(DISCRETESTACK_PROVIDER_ID, storedKey);
    expect((await runtime.getAuth(DISCRETESTACK_PROVIDER_ID))?.auth).toEqual({
      apiKey: storedKey,
      baseUrl: DISCRETESTACK_BASE_URLS.user,
    });
  });

  it('keeps models available with an invalid key type and rejects the request', async () => {
    vi.stubEnv(DISCRETESTACK_API_KEY_ENV, envKey);
    vi.stubEnv(DISCRETESTACK_KEY_TYPE_ENV, 'personal');
    const runtime = await createRuntime(authPath);
    expect(await runtime.checkAuth(DISCRETESTACK_PROVIDER_ID)).toEqual({ type: 'api_key', source: DISCRETESTACK_API_KEY_ENV });
    expect((await runtime.getAvailable(DISCRETESTACK_PROVIDER_ID)).map(({ id }) => id)).toEqual([maxModel, compactModel]);
    const failure = await runtime.getAuth(DISCRETESTACK_PROVIDER_ID).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).cause).toEqual(new Error(`${DISCRETESTACK_KEY_TYPE_ENV} must be "user" or "provider".`));
  });

  it.each([
    ['user', undefined],
    ['provider', 'provider'],
  ] as const)('sends %s-key requests to the matching endpoint', async (type, keyType) => {
    vi.stubEnv(DISCRETESTACK_API_KEY_ENV, envKey);
    if (keyType) vi.stubEnv(DISCRETESTACK_KEY_TYPE_ENV, keyType);
    const runtime = await createRuntime(authPath);
    const request = await sendChat(runtime, requireModel(runtime, maxModel));
    expect(request.url).toBe(`${DISCRETESTACK_BASE_URLS[type]}/chat/completions`);
    expect(request.headers.get('Authorization')).toBe(`Bearer ${envKey}`);
  });

  it('keeps the provider channel when a caller passes the resolved key and env back', async () => {
    await writeFile(authPath, JSON.stringify({
      [DISCRETESTACK_PROVIDER_ID]: { type: 'api_key', key: storedKey, env: { [DISCRETESTACK_KEY_TYPE_ENV]: 'provider' } },
    }));
    const runtime = await createRuntime(authPath);
    const resolved = await runtime.getAuth(DISCRETESTACK_PROVIDER_ID);
    if (!resolved?.auth.apiKey) throw new Error('DiscreteStack auth did not resolve');
    const request = await sendChat(runtime, requireModel(runtime, compactModel), {
      apiKey: resolved.auth.apiKey,
      ...(resolved.env ? { env: resolved.env } : {}),
    });
    expect(request.url).toBe(`${DISCRETESTACK_BASE_URLS.provider}/chat/completions`);
    expect(request.headers.get('Authorization')).toBe(`Bearer ${storedKey}`);
  });

  describe.each([maxModel, compactModel])('%s', (modelId) => {
    it.each([
      [undefined, 'none'],
      ['minimal', 'none'],
      ['high', 'high'],
    ] as const)('sends a chat completion with reasoning %s as %s', async (reasoning, effort) => {
      vi.stubEnv(DISCRETESTACK_API_KEY_ENV, envKey);
      const runtime = await createRuntime(authPath);
      const request = await sendChat(runtime, requireModel(runtime, modelId), reasoning ? { reasoning } : {});

      expect(request.method).toBe('POST');
      expect(request.url).toBe(`${DISCRETESTACK_BASE_URLS.user}/chat/completions`);
      const body = await request.json();
      expect(body).toMatchObject({ model: modelId, reasoning_effort: effort, max_tokens: 32 });
      expect(body).not.toHaveProperty('max_completion_tokens');
      expect(body).not.toHaveProperty('store');
      expect(body).not.toHaveProperty('thinking');
      expect(body).not.toHaveProperty('chat_template_kwargs');
    });
  });
});
