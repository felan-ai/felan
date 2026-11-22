import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSupportedThinkingLevels, ModelRuntime } from '@felan-ai/agent-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISCRETESTACK_API_KEY_ENV, DISCRETESTACK_PROVIDER, DISCRETESTACK_PROVIDER_ID } from '../src/provider.js';

const envKey = 'test-environment-value';
const storedKey = 'test-stored-value';
const maxModel = 'deepseek-v4.1-flash-1017';
const compactModel = 'glm-5.3-flash';

async function createRuntime(authPath: string) {
  const modelRuntime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerProvider(DISCRETESTACK_PROVIDER_ID, DISCRETESTACK_PROVIDER);
  return modelRuntime;
}

describe('DiscreteStack in the Pi model runtime', () => {
  let tempDir: string;
  let authPath: string;

  beforeEach(async () => {
    vi.stubEnv('PI_OFFLINE', '1');
    vi.stubEnv(DISCRETESTACK_API_KEY_ENV, undefined);
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
        api: 'openai-completions',
        reasoning: true,
        input: ['text', 'image'],
        maxTokens: 131072,
        contextWindow: 917504,
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

  it('uses the environment key only when it is configured', async () => {
    const runtime = await createRuntime(authPath);
    expect(runtime.getProviderAuthStatus(DISCRETESTACK_PROVIDER_ID)).toEqual({ configured: false });
    expect(await runtime.checkAuth(DISCRETESTACK_PROVIDER_ID)).toBeUndefined();

    vi.stubEnv(DISCRETESTACK_API_KEY_ENV, envKey);
    expect(runtime.getProviderAuthStatus(DISCRETESTACK_PROVIDER_ID)).toEqual({
      configured: true,
      source: 'environment',
      label: DISCRETESTACK_API_KEY_ENV,
    });
    expect((await runtime.getAuth(DISCRETESTACK_PROVIDER_ID))?.auth.apiKey).toBe(envKey);
  });

  it('offers API-key login and prefers the saved credential over the environment key', async () => {
    const runtime = await createRuntime(authPath);
    const provider = runtime.getProviders().find(({ id }) => id === DISCRETESTACK_PROVIDER_ID);
    expect(provider?.name).toBe('DiscreteStack');
    expect(provider?.auth.apiKey?.login).toBeTypeOf('function');

    const prompt = vi.fn(async () => storedKey);
    await runtime.login(DISCRETESTACK_PROVIDER_ID, 'api_key', { prompt, notify: vi.fn() });
    expect(prompt).toHaveBeenCalledExactlyOnceWith({ type: 'secret', message: 'Enter API key' });

    vi.stubEnv(DISCRETESTACK_API_KEY_ENV, envKey);
    const reopened = await createRuntime(authPath);
    await reopened.refresh({ allowNetwork: false, providers: [DISCRETESTACK_PROVIDER_ID] });
    expect(reopened.getProviderAuthStatus(DISCRETESTACK_PROVIDER_ID)).toEqual({ configured: true, source: 'stored' });
    expect((await reopened.getAuth(DISCRETESTACK_PROVIDER_ID))?.auth.apiKey).toBe(storedKey);
  });

  describe.each([maxModel, compactModel])('%s', (modelId) => {
    it.each([
      [undefined, 'none'],
      ['minimal', 'none'],
      ['high', 'high'],
    ] as const)('sends a chat completion with reasoning %s as %s', async (reasoning, effort) => {
      vi.stubEnv(DISCRETESTACK_API_KEY_ENV, envKey);
      const runtime = await createRuntime(authPath);
      const model = runtime.getModel(DISCRETESTACK_PROVIDER_ID, modelId);
      if (!model) throw new Error(`Model not registered: ${modelId}`);

      const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
        const chunk = { choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await runtime.streamSimple(model, {
        messages: [{ role: 'user', content: 'Say OK', timestamp: 0 }],
      }, { maxTokens: 32, maxRetries: 0, ...(reasoning ? { reasoning } : {}) }).result();

      expect(result.stopReason).toBe('stop');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      if (!call) throw new Error('No chat completion request captured');
      const request = new Request(...call);
      expect(request.method).toBe('POST');
      expect(request.url).toBe('https://api.discretestack.eu/provider/v1/chat/completions');
      expect(request.headers.get('Authorization')).toBe(`Bearer ${envKey}`);
      const body = await request.json();
      expect(body).toMatchObject({ model: modelId, reasoning_effort: effort, max_tokens: 32 });
      expect(body).not.toHaveProperty('max_completion_tokens');
      expect(body).not.toHaveProperty('store');
      expect(body).not.toHaveProperty('thinking');
      expect(body).not.toHaveProperty('chat_template_kwargs');
    });
  });
});
