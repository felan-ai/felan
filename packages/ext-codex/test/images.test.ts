import { Buffer } from 'node:buffer';
import {
  InMemoryCredentialStore,
  type ImagesContext,
  type ImagesOptions,
  ModelRuntime,
  normalizeContext,
} from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_IMAGE_MODEL_IDS,
  CODEX_IMAGES_API,
  CODEX_IMAGES_PROVIDER_ID,
  createCodexImageProvider,
} from '../src/images.js';

const ACCOUNT_ID = 'test-account-id';
const TOKEN = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID } });
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
const PROMPT: ImagesContext = { input: [{ type: 'text', text: 'Draw a fox' }] };
const AUTH_CONTEXT = { env: async () => undefined, fileExists: async () => false };

afterEach(() => vi.restoreAllMocks());

function jwt(payload: unknown): string {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.`;
}

function setup() {
  const available = vi.fn(async () => true);
  const resolveToken = vi.fn(async (): Promise<string | undefined> => TOKEN);
  const provider = createCodexImageProvider({ available, resolveToken });
  const model = provider.getAllModels?.().find((item) => item.id === CODEX_IMAGE_MODEL_IDS[0]);
  const auth = provider.auth.apiKey;
  const generateImages = provider.generateImages;
  if (!model || model.type !== 'image' || !auth?.check || !generateImages) {
    throw new Error('Missing image provider implementation');
  }
  return {
    provider,
    model,
    auth,
    check: auth.check,
    available,
    resolveToken,
    generate: (context: ImagesContext, options: ImagesOptions) => generateImages(model, context, options),
  };
}

function responseFetch(payload: unknown = { data: [{ b64_json: PNG }] }) {
  return vi.fn<typeof fetch>(async () => Response.json(payload));
}

describe('Codex image requests', () => {
  it('generates images with Codex headers, byte-derived MIME, usage and response id', async () => {
    const { generate, model } = setup();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({
      data: [{ b64_json: PNG, generation_id: 'generation-1' }],
      output_format: 'jpeg',
      usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46, extra: 100 },
    }, { headers: { 'x-codex-imagegen-request-id': 'request-1' } }));
    const headers = {
      'X-Custom': 'kept',
      'X-Removed': null,
      Authorization: 'wrong-token',
      'ChatGPT-Account-ID': 'wrong-account',
      Originator: 'wrong-originator',
      Accept: 'text/plain',
      'Content-Type': 'text/plain',
    };
    const before = Date.now();
    const result = await generate({ input: [
      { type: 'text', text: '  Draw a fox' },
      { type: 'text', text: 'in a forest  ' },
    ] }, { apiKey: TOKEN, headers, fetch });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe(`${model.baseUrl}/images/generations`);
    expect(request?.method).toBe('POST');
    expect(JSON.parse(String(request?.body))).toEqual({
      prompt: 'Draw a fox\n\nin a forest',
      model: 'gpt-image-2',
      background: 'opaque',
      quality: 'auto',
      size: 'auto',
    });
    expect(Object.fromEntries(new Headers(request?.headers))).toEqual({
      'x-custom': 'kept',
      authorization: `Bearer ${TOKEN}`,
      'chatgpt-account-id': ACCOUNT_ID,
      originator: 'pi',
      accept: 'application/json',
      'content-type': 'application/json',
    });
    expect(headers.Authorization).toBe('wrong-token');
    expect(result).toEqual({
      api: CODEX_IMAGES_API,
      provider: CODEX_IMAGES_PROVIDER_ID,
      model: model.id,
      output: [{ type: 'image', data: PNG, mimeType: 'image/png' }],
      stopReason: 'stop',
      timestamp: expect.any(Number),
      responseId: 'request-1',
      usage: {
        input: 12, output: 34, totalTokens: 46, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(Date.now());
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it('edits images using data URLs and the selected model id', async () => {
    const { provider } = setup();
    const model = provider.getAllModels?.().find((item) => item.id === 'gpt-image-2.5');
    if (!model || model.type !== 'image' || !provider.generateImages) throw new Error('Missing model');
    const fetch = responseFetch();
    const result = await provider.generateImages(model, { input: [
      { type: 'image', mimeType: 'image/png', data: PNG },
      ...PROMPT.input,
      { type: 'image', mimeType: 'image/jpeg', data: '/9j/' },
    ] }, { apiKey: TOKEN, fetch });

    expect(result.stopReason).toBe('stop');
    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe(`${model.baseUrl}/images/edits`);
    expect(JSON.parse(String(request?.body))).toEqual({
      images: [
        { image_url: `data:image/png;base64,${PNG}` },
        { image_url: 'data:image/jpeg;base64,/9j/' },
      ],
      prompt: 'Draw a fox',
      model: 'gpt-image-2.5',
      background: 'opaque',
      quality: 'auto',
      size: 'auto',
    });
  });

  it.each([5, 6])('handles %s reference images', async (count) => {
    const { generate } = setup();
    const fetch = responseFetch();
    const input: ImagesContext['input'] = Array.from({ length: count }, () => ({
      type: 'image', data: PNG, mimeType: 'image/png',
    }));
    const result = await generate({ input: [...PROMPT.input, ...input] }, { apiKey: TOKEN, fetch });
    expect(result.stopReason).toBe(count === 5 ? 'stop' : 'error');
    expect(fetch).toHaveBeenCalledTimes(count === 5 ? 1 : 0);
    if (count === 6) expect(result.errorMessage).toContain('at most 5');
  });

  it.each([
    { label: 'no prompt', context: { input: [] }, apiKey: TOKEN, error: 'prompt' },
    { label: 'blank prompt', context: { input: [{ type: 'text', text: ' \n\t ' }] }, apiKey: TOKEN, error: 'prompt' },
    { label: 'missing key', context: PROMPT, apiKey: undefined, error: '/login openai-codex' },
    { label: 'blank key', context: PROMPT, apiKey: ' ', error: '/login openai-codex' },
    { label: 'missing claim', context: PROMPT, apiKey: jwt({}), error: '/login openai-codex' },
    { label: 'invalid JWT', context: PROMPT, apiKey: 'invalid', error: '/login openai-codex' },
    { label: 'invalid payload', context: PROMPT, apiKey: 'e30.%%%%.', error: '/login openai-codex' },
    { label: 'invalid JSON', context: PROMPT, apiKey: 'e30.bm90LWpzb24.', error: '/login openai-codex' },
    { label: 'blank account', context: PROMPT, apiKey: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: ' ' } }), error: '/login openai-codex' },
    { label: 'non-string account', context: PROMPT, apiKey: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 42 } }), error: '/login openai-codex' },
  ] satisfies { label: string; context: ImagesContext; apiKey: string | undefined; error: string }[])(
    'rejects $label before fetching', async ({ context, apiKey, error }) => {
      const { generate } = setup();
      const fetch = responseFetch();
      const result = await generate(context, { ...(apiKey === undefined ? {} : { apiKey }), fetch });
      expect(result.stopReason).toBe('error');
      expect(result.errorMessage).toContain(error);
      expect(result.output).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    [401, 'The Codex login was rejected. Run /login openai-codex.'],
    [403, 'The Codex login was rejected. Run /login openai-codex.'],
    [429, 'Codex usage limit reached.'],
    [500, 'Codex image request failed (HTTP 500).'],
  ])('sanitizes HTTP %s failures', async (status, message) => {
    const { generate } = setup();
    const response = new Response(`private response ${TOKEN} ${ACCOUNT_ID}`, { status: Number(status) });
    const readBody = vi.spyOn(response, 'text');
    const cancelBody = vi.spyOn(response.body!, 'cancel');
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
    const result = await generate(PROMPT, { apiKey: TOKEN, fetch });
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toBe(message);
    expect(result.errorMessage).not.toContain(TOKEN);
    expect(result.errorMessage).not.toContain(ACCOUNT_ID);
    expect(result.errorMessage).not.toContain('private response');
    expect(readBody).not.toHaveBeenCalled();
    expect(cancelBody).toHaveBeenCalledOnce();
  });

  it('preserves the HTTP error when cancelling the response body fails', async () => {
    const { generate } = setup();
    const response = new Response('private response', { status: 429 });
    const cancelBody = vi.spyOn(response.body!, 'cancel').mockRejectedValue(new Error(`private ${TOKEN}`));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
    await expect(generate(PROMPT, { apiKey: TOKEN, fetch })).resolves.toMatchObject({
      stopReason: 'error', output: [], errorMessage: 'Codex usage limit reached.',
    });
    expect(cancelBody).toHaveBeenCalledOnce();
  });

  it('handles HTTP failures without a response body', async () => {
    const { generate } = setup();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 403 }));
    await expect(generate(PROMPT, { apiKey: TOKEN, fetch })).resolves.toMatchObject({
      stopReason: 'error', output: [], errorMessage: 'The Codex login was rejected. Run /login openai-codex.',
    });
  });

  it('returns a sanitized error for malformed JSON', async () => {
    const { generate } = setup();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(`private ${TOKEN}`));
    await expect(generate(PROMPT, { apiKey: TOKEN, fetch })).resolves.toMatchObject({
      stopReason: 'error', output: [], errorMessage: 'Codex image request failed.',
    });
  });

  it.each([
    null, {}, { data: [] }, { data: null }, { data: [{}] }, { data: [{ b64_json: '' }] },
    { data: [{ b64_json: 4 }] }, { data: [{ b64_json: '%%%%' }] },
    ...['AQ', 'AQI', 'AQ=', 'A===', 'A=AA', '====', 'AQ==\n', 'AQ-_']
      .map((b64_json) => ({ data: [{ b64_json }] })),
    { data: [{ b64_json: PNG }, { b64_json: '' }] },
  ])('rejects absent or invalid image data %#', async (payload) => {
    const { generate } = setup();
    await expect(generate(PROMPT, { apiKey: TOKEN, fetch: responseFetch(payload) })).resolves.toMatchObject({
      stopReason: 'error', output: [], errorMessage: 'Codex returned no image data.',
    });
  });

  it.each(['AQ==', 'AQI=', 'AQID', 'AR==', 'AQJ='])('accepts nonempty base64 in four-character blocks: %s', async (data) => {
    const { generate } = setup();
    await expect(generate(PROMPT, {
      apiKey: TOKEN, fetch: responseFetch({ data: [{ b64_json: data }] }),
    })).resolves.toMatchObject({
      stopReason: 'stop', output: [{ type: 'image', data, mimeType: 'image/png' }],
    });
  });

  it('never rejects or includes fetch error details', async () => {
    const { generate } = setup();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error(`private fetch failure ${TOKEN} ${ACCOUNT_ID}`);
    });
    await expect(generate(PROMPT, { apiKey: TOKEN, fetch })).resolves.toMatchObject({
      stopReason: 'error', output: [], errorMessage: 'Codex image request failed.',
    });
  });

  it('honors a caller abort during the request', async () => {
    const { generate } = setup();
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error(TOKEN)), { once: true });
    }));
    const pending = generate(PROMPT, { apiKey: TOKEN, signal: controller.signal, fetch });
    const signal = fetch.mock.calls[0]?.[1]?.signal;
    expect(signal).not.toBe(controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      stopReason: 'aborted', output: [], errorMessage: 'Codex image request aborted.',
    });
    expect(signal?.aborted).toBe(true);
  });

  it('does not fetch when the caller has already aborted', async () => {
    const { generate } = setup();
    const fetch = responseFetch();
    await expect(generate(PROMPT, { apiKey: TOKEN, signal: AbortSignal.abort(TOKEN), fetch }))
      .resolves.toMatchObject({ stopReason: 'aborted', errorMessage: 'Codex image request aborted.' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports its five-minute timeout as an error', async () => {
    const { generate } = setup();
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const fetch = vi.fn<typeof globalThis.fetch>((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error(TOKEN)), { once: true });
    }));
    const pending = generate(PROMPT, { apiKey: TOKEN, fetch });
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      stopReason: 'error', errorMessage: 'Codex image request timed out.',
    });
    expect(timeout).toHaveBeenCalledWith(300_000);
  });
});

describe('Codex image response metadata', () => {
  it.each([
    [[137, 80, 78, 71, 13, 10, 26, 10], 'jpeg', 'image/png'],
    [[255, 216, 255, 224], 'png', 'image/jpeg'],
    [Array.from(Buffer.from('RIFFxxxxWEBP')), 'png', 'image/webp'],
    [Array.from(Buffer.from('GIF87a')), 'png', 'image/gif'],
    [Array.from(Buffer.from('GIF89a')), 'png', 'image/gif'],
    [Array.from(Buffer.from('GIF89a')).map((byte) => byte | 128), 'png', 'image/png'],
    [[1, 2, 3], 'png', 'image/png'],
    [[1, 2, 3], 'jpeg', 'image/jpeg'],
    [[1, 2, 3], 'webp', 'image/webp'],
    [[1, 2, 3], 'gif', 'image/gif'],
    [[1, 2, 3], 'unknown', 'image/png'],
    [[1, 2, 3], { toString: true }, 'image/png'],
    [[1, 2, 3], undefined, 'image/png'],
  ] as const)('detects MIME from bytes or format %#', async (bytes, output_format, mimeType) => {
    const { generate } = setup();
    const data = Buffer.from(bytes).toString('base64');
    const result = await generate(PROMPT, {
      apiKey: TOKEN, fetch: responseFetch({ data: [{ b64_json: data }], output_format }),
    });
    expect(result.output).toEqual([{ type: 'image', data, mimeType }]);
    expect(result.stopReason).toBe('stop');
    expect(result).not.toHaveProperty('responseId');
  });

  it.each([
    undefined, null, {},
    { input_tokens: -1, output_tokens: 1, total_tokens: 1 },
    { input_tokens: 1, output_tokens: -1, total_tokens: 1 },
    { input_tokens: 1, output_tokens: 1, total_tokens: -1 },
    { input_tokens: NaN, output_tokens: 1, total_tokens: 1 },
    { input_tokens: 1, output_tokens: Infinity, total_tokens: 1 },
    { input_tokens: 1, output_tokens: 1, total_tokens: Infinity },
    { input_tokens: '1', output_tokens: 1, total_tokens: 1 },
  ])('omits absent or invalid usage %#', async (usage) => {
    const { generate } = setup();
    const response = Response.json({});
    vi.spyOn(response, 'json').mockResolvedValue({ data: [{ b64_json: PNG }], usage });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
    const result = await generate(PROMPT, { apiKey: TOKEN, fetch });
    expect(result.stopReason).toBe('stop');
    expect(result).not.toHaveProperty('usage');
  });

  it('preserves zero usage and every returned image', async () => {
    const { generate } = setup();
    const result = await generate(PROMPT, { apiKey: TOKEN, fetch: responseFetch({
      data: [{ b64_json: PNG }, { b64_json: PNG }],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    }) });
    expect(result.stopReason).toBe('stop');
    expect(result.output).toHaveLength(2);
    expect(result.usage).toMatchObject({ input: 0, output: 0, totalTokens: 0 });
  });
});

describe('Codex image provider', () => {
  it('lists only image models and offers no login flow', () => {
    const { provider, auth } = setup();
    expect(provider.id).toBe(CODEX_IMAGES_PROVIDER_ID);
    expect(provider.name).toBe('OpenAI Codex images');
    expect(provider.baseUrl).toBe('https://chatgpt.com/backend-api/codex');
    expect(provider.getModels()).toEqual([]);
    expect(provider.getAllModels?.()).toEqual(CODEX_IMAGE_MODEL_IDS.map((id, index) => ({
      type: 'image', id,
      name: `${index === 0 ? 'GPT Image 2' : 'GPT Image 2.5'} (Codex subscription)`,
      provider: CODEX_IMAGES_PROVIDER_ID,
      api: CODEX_IMAGES_API,
      baseUrl: provider.baseUrl,
      input: ['text', 'image'], output: ['image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })));
    expect(auth.name).toBe('OpenAI Codex login');
    expect(auth).not.toHaveProperty('login');
    expect(provider.auth).not.toHaveProperty('oauth');
  });

  it('checks availability without resolving tokens and passes through the abort signal', async () => {
    const { check, available, resolveToken } = setup();
    const signal = new AbortController().signal;
    const input = { ctx: AUTH_CONTEXT, signal };
    await expect(check(input)).resolves.toEqual({ type: 'api_key', source: 'OpenAI Codex login' });
    expect(available).toHaveBeenCalledWith(signal);
    expect(resolveToken).not.toHaveBeenCalled();
    available.mockResolvedValueOnce(false);
    await expect(check(input)).resolves.toBeUndefined();
    available.mockRejectedValueOnce(new Error('unavailable'));
    await expect(check(input)).resolves.toBeUndefined();
  });

  it('resolves the current token through the credentials bridge', async () => {
    const { auth, available, resolveToken } = setup();
    const signal = new AbortController().signal;
    const input = { ctx: AUTH_CONTEXT, signal };
    await expect(auth.resolve(input)).resolves.toEqual({
      auth: { apiKey: TOKEN }, source: 'OpenAI Codex login',
    });
    expect(resolveToken).toHaveBeenCalledWith(signal);
    expect(available).not.toHaveBeenCalled();
    for (const token of [undefined, '', ' ']) {
      resolveToken.mockResolvedValueOnce(token);
      await expect(auth.resolve(input)).resolves.toBeUndefined();
    }
  });

  it('returns error streams for both chat entry points', async () => {
    const { provider, model } = setup();
    const chatModel = { ...model, type: 'chat' as const, reasoning: false, contextWindow: 1, maxTokens: 1 };
    for (const stream of [provider.stream, provider.streamSimple]) {
      const result = stream(chatModel, normalizeContext({ messages: [] }));
      const events = [];
      for await (const event of result) events.push(event);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'error', reason: 'error' });
      await expect(result.result()).resolves.toMatchObject({
        stopReason: 'error', errorMessage: expect.stringContaining('no chat models'),
      });
    }
  });

  it('integrates with Pi availability and auth using only in-memory storage', async () => {
    const { provider, available, resolveToken } = setup();
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected global fetch'));
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(provider);
    const models = await runtime.getAvailableOfType('image', CODEX_IMAGES_PROVIDER_ID);
    expect(models.map((model) => model.id)).toEqual(CODEX_IMAGE_MODEL_IDS);
    expect(resolveToken).not.toHaveBeenCalled();
    available.mockResolvedValue(false);
    await expect(runtime.getAvailableOfType('image', CODEX_IMAGES_PROVIDER_ID)).resolves.toEqual([]);
    available.mockResolvedValue(true);

    const model = models[0]!;
    const fetch = responseFetch();
    const result = await runtime.generateImages(model, { input: [{ type: 'text', text: 'x' }] }, { fetch });
    expect(result.stopReason).toBe('stop');
    expect(resolveToken).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe(`${model.baseUrl}/images/generations`);
    expect(new Headers(request?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(new Headers(request?.headers).get('chatgpt-account-id')).toBe(ACCOUNT_ID);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
