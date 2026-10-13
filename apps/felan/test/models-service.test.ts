import {
  MODELS_SERVICE,
  createAssistantMessageEventStream,
  createFelanServiceRegistry,
  type AgentRuntime,
  type Api,
  type AssistantImages,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Classifier,
  type Context,
  type ImageApi,
  type ImageModel,
  type Model,
  type ModelReference,
  type ModelsCallOptions,
  type ModelRuntime,
  type ModelsService,
} from '@felan-ai/agent-core';
import type { ServiceProviderInstance } from '@felan-ai/daemon/provider';
import { describe, expect, it, vi } from 'vitest';
import modelsProvider, { createLocalModelsService, type LocalModelsRuntime } from '../src/providers/models.js';

const context: Context = { messages: [] };
const secret = 'private-credential-sentinel';

describe('local Models service', () => {
  it('limits subscription usage to authenticated models in the allowed scope', async () => {
    const { runtime, text } = fixture();
    const getSubscriptionUsage = vi.fn<NonNullable<ModelsService['getSubscriptionUsage']>>().mockResolvedValue({ ok: true, data: { used: 25 } });
    let allowed = [text];
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a', getSubscriptionUsage,
      getAllowedModels: () => allowed });
    await expect(service.getSubscriptionUsage!(text)).resolves.toEqual({ ok: true, data: { used: 25 } });
    expect(getSubscriptionUsage).toHaveBeenCalledWith({ provider: text.provider, id: text.id }, {});
    allowed = [];
    await expect(service.getSubscriptionUsage!(text)).rejects.toThrow('unavailable');
    expect(getSubscriptionUsage).toHaveBeenCalledOnce();
  });

  it('requires a session ID and exposes a narrow facade without startup discovery', () => {
    const { runtime } = fixture();
    expect(() => createLocalModelsService({ modelRuntime: runtime, sessionId: '' })).toThrow('session ID');
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a' });
    expect(Object.keys(service).sort()).toEqual([
      'completeSimple', 'generateImages', 'getAvailable', 'getAvailableOfType', 'streamSimple',
    ]);
    expect(Object.isFrozen(service)).toBe(true);
    expect(runtime.getAvailable).not.toHaveBeenCalled();
    expect(runtime.getAvailableOfType).not.toHaveBeenCalled();
  });

  it('returns detached public descriptors, omitting endpoints, headers, and extra metadata', async () => {
    const { runtime, text, image } = fixture();
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a' });
    const signal = new AbortController().signal;
    const [chat] = await service.getAvailable('fixture', { signal });
    const [picture] = await service.getAvailableOfType('image', 'fixture', { signal });
    expect(runtime.getAvailable).toHaveBeenCalledWith('fixture', { signal });
    expect(runtime.getAvailableOfType).toHaveBeenCalledWith('image', 'fixture', { signal });
    expect(chat).toEqual({
      id: text.id, name: text.name, provider: text.provider, api: text.api, input: text.input,
      cost: text.cost, reasoning: true, thinkingLevelMap: { low: 'low', high: 'high' },
      contextWindow: text.contextWindow, maxTokens: text.maxTokens,
    });
    expect(picture).toEqual({
      id: image.id, name: image.name, provider: image.provider, api: image.api,
      type: 'image', input: image.input, output: image.output, cost: image.cost,
    });
    expect(JSON.stringify([chat, picture])).not.toContain(secret);
    for (const descriptor of [chat!, picture!]) {
      expect(descriptor).not.toHaveProperty('headers');
      expect(descriptor).not.toHaveProperty('baseUrl');
      expect(descriptor).not.toHaveProperty('auth');
      expect(descriptor).not.toHaveProperty('compat');
    }
    chat!.cost.tiers![0]!.input = 99;
    chat!.input.push('image');
    chat!.thinkingLevelMap!.low = 'changed';
    picture!.output.push('text');
    expect(text.cost.tiers![0]!.input).toBe(2);
    expect(text.input).toEqual(['text']);
    expect(text.thinkingLevelMap!.low).toBe('low');
    expect(image.output).toEqual(['image']);
  });

  it('intersects current discovery with the current allowed scope on every operation', async () => {
    const { runtime, text, image } = fixture();
    let allowed: readonly ModelReference[] = [text, image];
    const getAllowedModels = vi.fn(() => allowed);
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a', getAllowedModels });
    expect(await service.getAvailable()).toHaveLength(1);
    expect(await service.getAvailableOfType('image')).toHaveLength(1);
    await service.completeSimple(text, context);
    await service.generateImages(image, { input: [] });
    await service.streamSimple(text, context).result();
    expect(getAllowedModels).toHaveBeenCalledTimes(5);
    allowed = [];
    expect(await service.getAvailable()).toEqual([]);
    await expect(service.completeSimple(text, context)).rejects.toThrow('unavailable');
    await expect(service.generateImages(image, { input: [] })).rejects.toThrow('unavailable');
    expect((await service.streamSimple(text, context).result()).stopReason).toBe('error');
    expect(runtime.completeSimple).toHaveBeenCalledOnce();
    expect(runtime.generateImages).toHaveBeenCalledOnce();
    expect(runtime.streamSimple).toHaveBeenCalledOnce();
    allowed = [text, image];
    runtime.getAvailable.mockResolvedValue([]);
    runtime.getAvailableOfType.mockResolvedValue([]);
    await expect(service.completeSimple(text, context)).rejects.toThrow('unavailable');
    await expect(service.generateImages(image, { input: [] })).rejects.toThrow('unavailable');
  });

  it('fails closed when an explicit allowed-scope callback returns invalid data', async () => {
    const { runtime, text } = fixture();
    const service = createLocalModelsService({
      modelRuntime: runtime, sessionId: 'session-a', getAllowedModels: () => undefined as never,
    });
    await expect(service.getAvailable()).rejects.toThrow('scope is unavailable');
    await expect(service.completeSimple(text, context)).rejects.toThrow('scope is unavailable');
    expect(runtime.completeSimple).not.toHaveBeenCalled();
  });

  it('checks both provider and ID and rejects unsupported discovery types', async () => {
    const { runtime, text } = fixture();
    const other = { ...text, provider: 'other' };
    runtime.getAvailable.mockResolvedValue([text, other]);
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a', getAllowedModels: () => [text] });
    expect(await service.getAvailable('fixture')).toHaveLength(1);
    expect(await service.getAvailable('other')).toEqual([]);
    await expect(service.completeSimple(other, context)).rejects.toThrow('unavailable');
    await expect(service.getAvailableOfType('chat' as never)).rejects.toThrow('Only image');
    expect(runtime.getAvailableOfType).not.toHaveBeenCalled();
    expect(runtime.completeSimple).not.toHaveBeenCalled();
  });

  it('re-resolves caller references and only forwards copied inference options', async () => {
    const { runtime, text, message } = fixture();
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a' });
    const signal = new AbortController().signal;
    const untrusted = { ...text, baseUrl: 'https://attacker.invalid', headers: { authorization: secret } };
    const request = {
      signal, maxTokens: 25, timeoutMs: 200, maxRetries: 0, reasoning: 'low' as const,
      cacheRetention: 'none' as const, sessionId: 'title-request',
      apiKey: secret, headers: { authorization: secret }, env: { TOKEN: secret },
      getApiKey: vi.fn(), onPayload: vi.fn(), fetch: vi.fn(), transformHeaders: vi.fn(),
    };
    expect(await service.completeSimple(untrusted, context, request)).toBe(message);
    const [actualModel, actualContext, actualOptions] = runtime.completeSimple.mock.calls[0]!;
    expect(actualModel).toBe(text);
    expect(actualContext).toBe(context);
    expect(actualOptions).toEqual({
      signal, maxTokens: 25, timeoutMs: 200, maxRetries: 0, reasoning: 'low', cacheRetention: 'none',
      sessionId: expect.stringMatching(/^felan-models:[a-f0-9]{64}$/u),
    });
    expect(actualOptions).not.toBe(request);
    expect(JSON.stringify(actualOptions)).not.toContain(secret);
    const replacement = { ...text, baseUrl: 'https://current-provider.invalid' };
    runtime.getAvailable.mockResolvedValue([replacement]);
    const response = await service.streamSimple(untrusted, context, request).result();
    expect(response).toBe(message);
    expect(response.usage).toBe(message.usage);
    expect(runtime.streamSimple.mock.calls[0]![0]).toBe(replacement);
    expect(runtime.streamSimple.mock.calls[0]![2]).toEqual(actualOptions);
    const otherSession = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-b' });
    await otherSession.completeSimple(text, context, request);
    expect(runtime.completeSimple.mock.calls[1]![2]?.sessionId).not.toBe(actualOptions!.sessionId);
    await service.completeSimple(text, context, { sessionId: 'different-request' });
    expect(runtime.completeSimple.mock.calls[2]![2]?.sessionId).not.toBe(actualOptions!.sessionId);
  });

  it('uses canonical image models, strips request authority, and preserves actual usage', async () => {
    const { runtime, image, images } = fixture();
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a' });
    const signal = new AbortController().signal;
    const input = { input: [{ type: 'text' as const, text: 'A mountain' }] };
    const result = await service.generateImages({ ...image, baseUrl: 'https://attacker.invalid' }, input, {
      signal, apiKey: secret, headers: { authorization: secret },
    } as { signal: AbortSignal });
    expect(runtime.generateImages).toHaveBeenCalledWith(image, input, { signal });
    expect(result).toBe(images);
    expect(result.usage).toBe(images.usage);
  });

  it('snapshots allowed request options before asynchronous preflight', async () => {
    const { runtime, text } = fixture();
    const entered = deferred<void>();
    const discovered = deferred<readonly Model<Api>[]>();
    runtime.getAvailable.mockImplementation(() => { entered.resolve(); return discovered.promise; });
    const controller = new AbortController();
    const request = { maxTokens: 20, signal: controller.signal };
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a' });
    const result = service.completeSimple(text, context, request);
    await entered.promise;
    request.maxTokens = 99;
    request.signal = new AbortController().signal;
    discovered.resolve([text]);
    await result;
    expect(runtime.completeSimple.mock.calls[0]![2]).toMatchObject({ maxTokens: 20, signal: controller.signal });
  });

  it.each([
    { maxTokens: 0 }, { maxTokens: NaN }, { maxRetries: -1 }, { timeoutMs: Infinity },
    { reasoning: 'invalid' }, { cacheRetention: 'invalid' }, { sessionId: 123 },
  ])('rejects invalid inference options %j without dispatch', async request => {
    const { runtime, text } = fixture();
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a' });
    await expect(service.completeSimple(text, context, request as unknown as ModelsCallOptions)).rejects.toThrow('Invalid');
    expect(runtime.completeSimple).not.toHaveBeenCalled();
  });

  it('does not start discovery or inference when already aborted', async () => {
    const { runtime, text, image } = fixture();
    const controller = new AbortController();
    controller.abort(secret);
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a' });
    await expect(service.getAvailable(undefined, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(service.getAvailableOfType('image', undefined, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(service.completeSimple(text, context, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(service.generateImages(image, { input: [] }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const result = await service.streamSimple(text, context, { signal: controller.signal }).result();
    expect(result).toMatchObject({ stopReason: 'aborted', errorMessage: 'Model request aborted.' });
    expect(JSON.stringify(result)).not.toContain(secret);
    for (const operation of Object.values(runtime)) expect(operation).not.toHaveBeenCalled();
  });

  it('cancels stream preflight promptly and never dispatches after late discovery', async () => {
    const { runtime, text } = fixture();
    const entered = deferred<void>();
    const discovered = deferred<readonly Model<Api>[]>();
    runtime.getAvailable.mockImplementation(() => { entered.resolve(); return discovered.promise; });
    const controller = new AbortController();
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a' });
    const output = service.streamSimple(text, context, { signal: controller.signal });
    await entered.promise;
    controller.abort(secret);
    expect((await output.result()).stopReason).toBe('aborted');
    discovered.resolve([text]);
    await Promise.resolve();
    expect(runtime.streamSimple).not.toHaveBeenCalled();
    expect(runtime.getAvailable).toHaveBeenCalledWith('fixture', { signal: controller.signal });
  });

  it('cancels a pending allowed-scope lookup without dispatching inference', async () => {
    const { runtime, text } = fixture();
    const entered = deferred<void>();
    const scope = deferred<readonly ModelReference[]>();
    const controller = new AbortController();
    const service = createLocalModelsService({
      modelRuntime: runtime, sessionId: 'session-a',
      getAllowedModels: signal => { expect(signal).toBe(controller.signal); entered.resolve(); return scope.promise; },
    });
    const output = service.streamSimple(text, context, { signal: controller.signal });
    await entered.promise;
    controller.abort();
    expect((await output.result()).stopReason).toBe('aborted');
    scope.resolve([text]);
    await Promise.resolve();
    expect(runtime.streamSimple).not.toHaveBeenCalled();
  });

  it('awaits dispatched stream cleanup and provider settlement after abort', async () => {
    const { runtime, text, message } = fixture();
    const entered = deferred<void>();
    const cleanupStarted = deferred<void>();
    const cleanup = deferred<void>();
    const resultRequested = deferred<void>();
    const providerResult = deferred<AssistantMessage>();
    const next = deferred<IteratorResult<never>>();
    const close = vi.fn(async () => { cleanupStarted.resolve(); await cleanup.promise; return { done: true as const, value: undefined }; });
    runtime.streamSimple.mockImplementation(() => {
      entered.resolve();
      return {
        [Symbol.asyncIterator]: () => ({ next: () => next.promise, return: close }),
        result: () => { resultRequested.resolve(); return providerResult.promise; },
      } as unknown as AssistantMessageEventStream;
    });
    const controller = new AbortController();
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a' });
    const output = service.streamSimple(text, context, { signal: controller.signal });
    let settled = false;
    const result = output.result().then(value => { settled = true; return value; });
    await entered.promise;
    controller.abort();
    await cleanupStarted.promise;
    expect(settled).toBe(false);
    expect(runtime.streamSimple.mock.calls[0]![2]?.signal).toBe(controller.signal);
    cleanup.resolve();
    await resultRequested.promise;
    expect(settled).toBe(false);
    providerResult.resolve({ ...message, stopReason: 'aborted', errorMessage: secret });
    await Promise.resolve();
    expect(settled).toBe(false);
    next.resolve({ done: true, value: undefined });
    const final = await result;
    expect(close).toHaveBeenCalledOnce();
    expect(final.stopReason).toBe('aborted');
    expect(final.usage).toBe(message.usage);
    expect(final.errorMessage).not.toContain(secret);
  });

  it('waits for an active completion and preserves its aborted usage', async () => {
    const { runtime, text, message } = fixture();
    const started = deferred<void>();
    const providerResult = deferred<AssistantMessage>();
    runtime.completeSimple.mockImplementation(() => { started.resolve(); return providerResult.promise; });
    const controller = new AbortController();
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a' });
    let settled = false;
    const result = service.completeSimple(text, context, { signal: controller.signal }).finally(() => { settled = true; });
    await started.promise;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(runtime.completeSimple.mock.calls[0]![2]?.signal).toBe(controller.signal);
    providerResult.resolve({ ...message, stopReason: 'aborted', errorMessage: secret });
    const final = await result;
    expect(final.stopReason).toBe('aborted');
    expect(final.usage).toBe(message.usage);
    expect(final.errorMessage).not.toContain(secret);
  });

  it('waits for active image generation and preserves its aborted usage', async () => {
    const { runtime, image, images } = fixture();
    const started = deferred<void>();
    const providerResult = deferred<AssistantImages>();
    runtime.generateImages.mockImplementation(() => { started.resolve(); return providerResult.promise; });
    const controller = new AbortController();
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a' });
    let settled = false;
    const result = service.generateImages(image, { input: [] }, { signal: controller.signal }).finally(() => { settled = true; });
    await started.promise;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(runtime.generateImages.mock.calls[0]![2]?.signal).toBe(controller.signal);
    providerResult.resolve({ ...images, stopReason: 'aborted', errorMessage: secret });
    const final = await result;
    expect(final.stopReason).toBe('aborted');
    expect(final.usage).toBe(images.usage);
    expect(final.errorMessage).not.toContain(secret);
  });

  it('forwards detached partial snapshots without provider errors or diagnostics', async () => {
    const { runtime, text, message } = fixture();
    const source = createAssistantMessageEventStream();
    runtime.streamSimple.mockReturnValue(source);
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a' });
    const output = service.streamSimple(text, context);
    const partial: AssistantMessage = {
      ...message, usage: structuredClone(message.usage), stopReason: 'pending',
      errorMessage: secret, diagnostics: [{ message: secret }] as never,
    };
    source.push({ type: 'start', partial });
    const reader = output[Symbol.asyncIterator]();
    const first = await reader.next();
    expect(first.value).toMatchObject({ type: 'start', partial: { usage: { input: 5 } } });
    expect(first.value.partial).not.toBe(partial);
    partial.usage.input = 999;
    partial.errorMessage = `${secret}-changed`;
    expect(first.value.partial.usage.input).toBe(5);
    source.push({ type: 'text_delta', contentIndex: 0, delta: 'text', partial });
    source.push({ type: 'error', reason: 'error', error: { ...message, stopReason: 'error', errorMessage: secret } });
    const events = [first.value];
    for (;;) {
      const next = await reader.next();
      if (next.done) break;
      events.push(next.value);
    }
    expect(events.map(event => event.type)).toEqual(['start', 'text_delta', 'error']);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect((await output.result()).usage).toBe(message.usage);
  });

  it('redacts thrown provider failures and structured error diagnostics', async () => {
    const { runtime, text, image, message, images } = fixture();
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a' });
    runtime.getAvailable.mockRejectedValueOnce(new Error(secret));
    await expect(service.getAvailable()).rejects.toThrow('Model discovery failed.');
    runtime.completeSimple.mockRejectedValueOnce(new Error(secret));
    await expect(service.completeSimple(text, context)).rejects.toThrow('Model completion failed.');
    runtime.generateImages.mockRejectedValueOnce(new Error(secret));
    await expect(service.generateImages(image, { input: [] })).rejects.toThrow('Image generation failed.');
    runtime.streamSimple.mockImplementationOnce(() => { throw new Error(secret); });
    const failedStream = await service.streamSimple(text, context).result();
    expect(failedStream.stopReason).toBe('error');
    expect(JSON.stringify(failedStream)).not.toContain(secret);
    const failed = { ...message, stopReason: 'error' as const, errorMessage: secret, diagnostics: [{ message: secret }] as never };
    runtime.completeSimple.mockResolvedValueOnce(failed);
    const result = await service.completeSimple(text, context);
    expect(result.usage).toBe(message.usage);
    expect(JSON.stringify(result)).not.toContain(secret);
    runtime.streamSimple.mockImplementationOnce(() => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'error', reason: 'error', error: failed });
      return stream;
    });
    const streamResult = await service.streamSimple(text, context).result();
    expect(streamResult.usage).toBe(message.usage);
    expect(JSON.stringify(streamResult)).not.toContain(secret);
    runtime.completeSimple.mockResolvedValueOnce({ ...message, errorMessage: secret, diagnostics: failed.diagnostics });
    const successful = await service.completeSimple(text, context);
    expect(successful.stopReason).toBe('stop');
    expect(successful.usage).toBe(message.usage);
    expect(JSON.stringify(successful)).not.toContain(secret);
    runtime.generateImages.mockResolvedValueOnce({ ...images, errorMessage: secret });
    expect(JSON.stringify(await service.generateImages(image, { input: [] }))).not.toContain(secret);
  });

  it('exposes only the optional classifier operations with cancellation and safe errors', async () => {
    const { runtime } = fixture();
    const response = { answers: {}, metadata: { usage: { requests: 1, inputTokens: 7, costUsd: 0.01 } } };
    const classifier = {
      privateToken: secret,
      canEvaluate: vi.fn(function (this: { privateToken: string }) { return this.privateToken === secret; }),
      classify: vi.fn<Classifier['classify']>().mockResolvedValue(response),
    };
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a', classifier });
    const signal = new AbortController().signal;
    expect(Object.keys(service.classifier!).sort()).toEqual(['canEvaluate', 'classify']);
    expect(service.classifier!.canEvaluate!({}, {})).toBe(true);
    expect(await service.classifier!.classify({}, {}, signal)).toBe(response);
    expect(classifier.classify).toHaveBeenCalledWith({}, {}, signal);
    classifier.classify.mockRejectedValueOnce(new Error(secret));
    await expect(service.classifier!.classify({}, {})).rejects.toThrow('Classification failed.');
    const controller = new AbortController(); controller.abort(secret);
    await expect(service.classifier!.classify({}, {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(classifier.classify).toHaveBeenCalledTimes(2);
  });

  it.each(['caller', 'lifetime'] as const)('combines caller and facade lifetime signals when %s aborts', async abortSource => {
    const { runtime, text, message } = fixture();
    const caller = new AbortController();
    const lifetime = new AbortController();
    const started = deferred<void>();
    const providerResult = deferred<AssistantMessage>();
    runtime.completeSimple.mockImplementation(() => { started.resolve(); return providerResult.promise; });
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a', signal: lifetime.signal });
    let settled = false;
    const completion = service.completeSimple(text, context, { signal: caller.signal }).finally(() => { settled = true; });
    await started.promise;
    const combined = runtime.completeSimple.mock.calls[0]![2]!.signal!;
    expect(combined).not.toBe(caller.signal);
    expect(combined).not.toBe(lifetime.signal);
    expect(runtime.getAvailable.mock.calls[0]![1]?.signal).toBe(combined);
    expect(combined.aborted).toBe(false);
    (abortSource === 'caller' ? caller : lifetime).abort(secret);
    expect(combined.aborted).toBe(true);
    expect((abortSource === 'caller' ? lifetime : caller).signal.aborted).toBe(false);
    await Promise.resolve();
    expect(settled).toBe(false);
    providerResult.resolve({ ...message, stopReason: 'aborted', errorMessage: secret });
    expect(await completion).toMatchObject({ stopReason: 'aborted', errorMessage: 'Model request aborted.', usage: message.usage });
  });

  it('forwards the combined lifetime signal to image discovery and generation', async () => {
    const { runtime, image } = fixture();
    const caller = new AbortController();
    const lifetime = new AbortController();
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a', signal: lifetime.signal });
    await service.generateImages(image, { input: [] }, { signal: caller.signal });
    const combined = runtime.generateImages.mock.calls[0]![2]!.signal!;
    expect(combined).not.toBe(caller.signal);
    expect(combined).not.toBe(lifetime.signal);
    expect(runtime.getAvailableOfType.mock.calls[0]![2]?.signal).toBe(combined);
    lifetime.abort();
    expect(combined.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
  });

  it('rejects every facade operation after lifetime abort without reaching the runtime', async () => {
    const { runtime, text, image } = fixture();
    const classifier = { canEvaluate: vi.fn(() => true), classify: vi.fn<Classifier['classify']>() };
    const lifetime = new AbortController();
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a', classifier, signal: lifetime.signal });
    lifetime.abort(secret);
    await expect(service.getAvailable()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(service.getAvailableOfType('image')).rejects.toMatchObject({ name: 'AbortError' });
    await expect(service.completeSimple(text, context)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(service.generateImages(image, { input: [] })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await service.streamSimple(text, context).result()).toMatchObject({ stopReason: 'aborted', errorMessage: 'Model request aborted.' });
    expect(service.classifier!.canEvaluate!({}, {})).toBe(false);
    await expect(service.classifier!.classify({}, {})).rejects.toMatchObject({ name: 'AbortError' });
    for (const operation of [...Object.values(runtime), ...Object.values(classifier)]) expect(operation).not.toHaveBeenCalled();
  });

  it.each(['completion', 'stream', 'images'] as const)('rechecks activation after awaited discovery before dispatching %s', async operation => {
    const { runtime, text, image } = fixture();
    const entered = deferred<void>();
    const discovery = deferred<void>();
    runtime.getAvailable.mockImplementation(async () => { entered.resolve(); await discovery.promise; return [text]; });
    runtime.getAvailableOfType.mockImplementation(async () => { entered.resolve(); await discovery.promise; return [image]; });
    let active = true;
    const service = createLocalModelsService({ modelRuntime: runtime, sessionId: 'session-a', isActive: () => active });
    const pending = operation === 'completion' ? service.completeSimple(text, context)
      : operation === 'images' ? service.generateImages(image, { input: [] })
        : service.streamSimple(text, context).result();
    await entered.promise;
    active = false;
    discovery.resolve();
    if (operation === 'stream') expect(await pending).toMatchObject({ stopReason: 'error' });
    else await expect(pending).rejects.toThrow('before activation or while settling');
    expect(runtime.completeSimple).not.toHaveBeenCalled();
    expect(runtime.streamSimple).not.toHaveBeenCalled();
    expect(runtime.generateImages).not.toHaveBeenCalled();
    expect(await service.getAvailable()).toHaveLength(1);
    expect(await service.getAvailableOfType('image')).toHaveLength(1);
  });
});

describe('default session-scoped Models provider', () => {
  it('allows metadata discovery before activation but gates every inference operation', async () => {
    const classifier = { canEvaluate: vi.fn(() => true), classify: vi.fn<Classifier['classify']>().mockResolvedValue({ answers: {} }) };
    const h = await providerFixture({ classifier });
    try {
      await expectInferenceInactive(h.service, h.text, h.image);
      expect(h.runtime.getAvailable).not.toHaveBeenCalled();
      expect(h.runtime.getAvailableOfType).not.toHaveBeenCalled();
      expect(await h.service.getAvailable()).toHaveLength(1);
      expect(await h.service.getAvailableOfType('image')).toHaveLength(1);
      await expectInferenceInactive(h.service, h.text, h.image);
      expect(h.runtime.getAvailable).toHaveBeenCalledOnce();
      expect(h.runtime.getAvailableOfType).toHaveBeenCalledOnce();
      expect(h.runtime.completeSimple).not.toHaveBeenCalled();
      expect(h.runtime.streamSimple).not.toHaveBeenCalled();
      expect(h.runtime.generateImages).not.toHaveBeenCalled();
      expect(classifier.canEvaluate).not.toHaveBeenCalled();
      expect(classifier.classify).not.toHaveBeenCalled();

      expect(h.instance.activate).toBeTypeOf('function');
      await h.instance.activate!();
      expect(await h.service.completeSimple(h.text, context)).toBe(h.message);
      expect(await h.service.streamSimple(h.text, context).result()).toBe(h.message);
      expect(await h.service.generateImages(h.image, { input: [] })).toBe(h.images);
      expect(h.service.classifier!.canEvaluate!({}, {})).toBe(true);
      expect(await h.service.classifier!.classify({}, {})).toEqual({ answers: {} });
      expect(h.runtime.completeSimple).toHaveBeenCalledOnce();
      expect(h.runtime.streamSimple).toHaveBeenCalledOnce();
      expect(h.runtime.generateImages).toHaveBeenCalledOnce();
      expect(classifier.classify).toHaveBeenCalledOnce();
    } finally {
      await h.instance.dispose();
    }
  });

  it('declares the shared contract and creates isolated services for sessions sharing a root', async () => {
    expect(modelsProvider.scope).toBe('session');
    expect(modelsProvider.provides).toEqual([MODELS_SERVICE]);
    const first = await providerFixture({ sessionId: 'root', rootSessionId: 'root' });
    const second = await providerFixture({ sessionId: 'child', rootSessionId: 'root' });
    try {
      expect(first.instance.implementations).toHaveLength(1);
      expect(first.instance.implementations[0]!.contract).toBe(MODELS_SERVICE);
      expect(first.service).not.toBe(second.service);
      expect(first.runtime.getAvailable).not.toHaveBeenCalled();
      expect(second.runtime.getAvailable).not.toHaveBeenCalled();
      const descriptors = [await first.service.getAvailable(), await second.service.getAvailableOfType('image')];
      expect(JSON.stringify(descriptors)).not.toMatch(/baseUrl|headers|compat|private-credential-sentinel/);
      await first.instance.activate!();
      await second.instance.activate!();
      await first.service.completeSimple(first.text, context, { sessionId: 'same-hint' });
      await second.service.completeSimple(second.text, context, { sessionId: 'same-hint' });
      expect(first.runtime.completeSimple.mock.calls[0]![2]!.sessionId)
        .not.toBe(second.runtime.completeSimple.mock.calls[0]![2]!.sessionId);
      await first.instance.dispose();
      await expect(first.service.getAvailable()).rejects.toMatchObject({ name: 'AbortError' });
      expect(await second.service.getAvailable()).toHaveLength(1);
    } finally {
      await first.instance.dispose();
      await second.instance.dispose();
    }
  });

  it('treats undefined allowedModels as unrestricted and an empty list as deny-all', async () => {
    const unrestricted = await providerFixture();
    const denied = await providerFixture({ allowedModels: [] });
    try {
      expect(await unrestricted.service.getAvailable()).toHaveLength(1);
      expect(await unrestricted.service.getAvailableOfType('image')).toHaveLength(1);
      expect(await denied.service.getAvailable()).toEqual([]);
      expect(await denied.service.getAvailableOfType('image')).toEqual([]);
      await unrestricted.instance.activate!();
      await denied.instance.activate!();
      await expect(denied.service.completeSimple(denied.text, context)).rejects.toThrow('unavailable');
      await expect(denied.service.generateImages(denied.image, { input: [] })).rejects.toThrow('unavailable');
      expect((await denied.service.streamSimple(denied.text, context).result()).stopReason).toBe('error');
      expect(denied.runtime.completeSimple).not.toHaveBeenCalled();
      expect(denied.runtime.generateImages).not.toHaveBeenCalled();
      expect(denied.runtime.streamSimple).not.toHaveBeenCalled();
    } finally {
      await unrestricted.instance.dispose();
      await denied.instance.dispose();
    }
  });

  it('rejects calls after its parent lifetime abort without affecting another session', async () => {
    const first = await providerFixture();
    const second = await providerFixture({ sessionId: 'session-b' });
    try {
      await first.instance.activate!();
      await second.instance.activate!();
      first.parentLifetime.abort(secret);
      await expect(first.service.getAvailable()).rejects.toMatchObject({ name: 'AbortError' });
      await expect(first.service.completeSimple(first.text, context)).rejects.toMatchObject({ name: 'AbortError' });
      expect(first.runtime.getAvailable).not.toHaveBeenCalled();
      expect(first.runtime.completeSimple).not.toHaveBeenCalled();
      expect(await second.service.getAvailable()).toHaveLength(1);
    } finally {
      await first.instance.dispose();
      await second.instance.dispose();
    }
  });

  it('aborts active completion on dispose but keeps disposal pending until the provider settles', async () => {
    const h = await providerFixture();
    await h.instance.activate!();
    const started = deferred<void>();
    const providerResult = deferred<AssistantMessage>();
    h.runtime.completeSimple.mockImplementation(() => { started.resolve(); return providerResult.promise; });
    let completed = false;
    const completion = h.service.completeSimple(h.text, context).finally(() => { completed = true; });
    await started.promise;
    const signal = h.runtime.completeSimple.mock.calls[0]![2]!.signal!;
    let disposed = false;
    let disposedAgain = false;
    const disposal = h.instance.dispose().then(() => { disposed = true; });
    const repeatedDisposal = h.instance.dispose().then(() => { disposedAgain = true; });
    try {
      expect(signal.aborted).toBe(true);
      expect(h.parentSignal.aborted).toBe(false);
      await expect(h.service.getAvailable()).rejects.toMatchObject({ name: 'AbortError' });
      await expect(h.service.completeSimple(h.text, context)).rejects.toMatchObject({ name: 'AbortError' });
      expect(h.runtime.completeSimple).toHaveBeenCalledOnce();
      expect(completed).toBe(false);
      expect(disposed).toBe(false);
      expect(disposedAgain).toBe(false);
    } finally {
      providerResult.resolve({ ...h.message, stopReason: 'aborted', errorMessage: secret });
      await Promise.all([completion, disposal, repeatedDisposal]);
    }
    expect(completed && disposed && disposedAgain).toBe(true);
    expect(await completion).toMatchObject({ stopReason: 'aborted', errorMessage: 'Model request aborted.', usage: h.message.usage });
    await expect(h.service.getAvailableOfType('image')).rejects.toMatchObject({ name: 'AbortError' });
    await expect(h.service.generateImages(h.image, { input: [] })).rejects.toMatchObject({ name: 'AbortError' });
    expect((await h.service.streamSimple(h.text, context).result()).stopReason).toBe('aborted');
    expect(h.runtime.generateImages).not.toHaveBeenCalled();
    expect(h.runtime.streamSimple).not.toHaveBeenCalled();
  });

  it('drains active completion and image work without cancelling either operation', async () => {
    const classifier = { canEvaluate: vi.fn(() => true), classify: vi.fn<Classifier['classify']>().mockResolvedValue({ answers: {} }) };
    const h = await providerFixture({ classifier });
    await h.instance.activate!();
    const completionStarted = deferred<void>();
    const imageStarted = deferred<void>();
    const completionResult = deferred<AssistantMessage>();
    const imageResult = deferred<AssistantImages>();
    h.runtime.completeSimple.mockImplementation(() => { completionStarted.resolve(); return completionResult.promise; });
    h.runtime.generateImages.mockImplementation(() => { imageStarted.resolve(); return imageResult.promise; });
    const completion = h.service.completeSimple(h.text, context);
    const generation = h.service.generateImages(h.image, { input: [] });
    await Promise.all([completionStarted.promise, imageStarted.promise]);
    let settled = false;
    const drain = h.instance.settle!('drain').then(() => { settled = true; });
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(h.runtime.completeSimple.mock.calls[0]![2]!.signal!.aborted).toBe(false);
      expect(h.runtime.generateImages.mock.calls[0]![2]!.signal!.aborted).toBe(false);
      await expectInferenceInactive(h.service, h.text, h.image);
      expect(await h.service.getAvailable()).toHaveLength(1);
      expect(await h.service.getAvailableOfType('image')).toHaveLength(1);
      expect(settled).toBe(false);
      completionResult.resolve(h.message);
      expect(await completion).toBe(h.message);
      expect(settled).toBe(false);
      imageResult.resolve(h.images);
      expect(await generation).toBe(h.images);
      await drain;
      expect(settled).toBe(true);
      expect(await h.service.getAvailable()).toHaveLength(1);
      await expectInferenceInactive(h.service, h.text, h.image);
      expect(h.runtime.completeSimple).toHaveBeenCalledOnce();
      expect(h.runtime.generateImages).toHaveBeenCalledOnce();
      expect(h.runtime.streamSimple).not.toHaveBeenCalled();
      expect(classifier.classify).not.toHaveBeenCalled();
      expect(classifier.canEvaluate).not.toHaveBeenCalled();
    } finally {
      completionResult.resolve(h.message);
      imageResult.resolve(h.images);
      await Promise.all([completion, generation, drain]);
      await h.instance.dispose();
    }
  });

  it.each(['completion', 'stream', 'images'] as const)('does not dispatch %s when drain starts during discovery', async operation => {
    const h = await providerFixture();
    await h.instance.activate!();
    const entered = deferred<void>();
    const discovery = deferred<void>();
    h.runtime.getAvailable.mockImplementation(async () => { entered.resolve(); await discovery.promise; return [h.text]; });
    h.runtime.getAvailableOfType.mockImplementation(async () => { entered.resolve(); await discovery.promise; return [h.image]; });
    const pending = operation === 'completion' ? h.service.completeSimple(h.text, context)
      : operation === 'images' ? h.service.generateImages(h.image, { input: [] })
        : h.service.streamSimple(h.text, context).result();
    await entered.promise;
    let drained = false;
    const drain = h.instance.settle!('drain').then(() => { drained = true; });
    try {
      await Promise.resolve();
      expect(drained).toBe(false);
      const signal = operation === 'images'
        ? h.runtime.getAvailableOfType.mock.calls[0]![2]!.signal!
        : h.runtime.getAvailable.mock.calls[0]![1]!.signal!;
      expect(signal.aborted).toBe(false);
      discovery.resolve();
      if (operation === 'stream') expect(await pending).toMatchObject({ stopReason: 'error' });
      else await expect(pending).rejects.toThrow('before activation or while settling');
      await drain;
      expect(drained).toBe(true);
      expect(h.runtime.completeSimple).not.toHaveBeenCalled();
      expect(h.runtime.streamSimple).not.toHaveBeenCalled();
      expect(h.runtime.generateImages).not.toHaveBeenCalled();
      expect(await h.service.getAvailable()).toHaveLength(1);
    } finally {
      discovery.resolve();
      await Promise.allSettled([pending, drain]);
      await h.instance.dispose();
    }
  });

  it('keeps stream disposal pending until the source stream settles', async () => {
    const h = await providerFixture();
    await h.instance.activate!();
    const started = deferred<void>();
    const source = createAssistantMessageEventStream();
    h.runtime.streamSimple.mockImplementation(() => { started.resolve(); return source; });
    const output = h.service.streamSimple(h.text, context);
    await started.promise;
    let disposed = false;
    const disposal = h.instance.dispose().then(() => { disposed = true; });
    try {
      await Promise.resolve();
      expect(disposed).toBe(false);
      expect(h.runtime.streamSimple.mock.calls[0]![2]!.signal!.aborted).toBe(true);
    } finally {
      source.push({ type: 'error', reason: 'aborted', error: { ...h.message, stopReason: 'aborted', errorMessage: secret } });
      expect(await output.result()).toMatchObject({ stopReason: 'aborted', errorMessage: 'Model request aborted.' });
      await disposal;
    }
    expect(disposed).toBe(true);
  });
});

async function expectInferenceInactive(service: ModelsService, text: ModelReference, image: ModelReference) {
  await expect(service.completeSimple(text, context)).rejects.toThrow('before activation or while settling');
  expect(await service.streamSimple(text, context).result()).toMatchObject({ stopReason: 'error' });
  await expect(service.generateImages(image, { input: [] })).rejects.toThrow('before activation or while settling');
  expect(service.classifier).toBeDefined();
  expect(service.classifier!.canEvaluate!({}, {})).toBe(false);
  await expect(service.classifier!.classify({}, {})).rejects.toThrow('before activation or while settling');
}

async function providerFixture(options: {
  sessionId?: string;
  rootSessionId?: string;
  allowedModels?: readonly ModelReference[];
  classifier?: Classifier;
} = {}) {
  const f = fixture();
  const controller = new AbortController();
  const instance: ServiceProviderInstance = await modelsProvider.create({
    services: createFelanServiceRegistry(), options: undefined, signal: controller.signal,
    runtime: { storage: () => ({ root: '/fixture-agent' }), ...(options.classifier ? { classifier: options.classifier } : {}) } as AgentRuntime,
    modelRuntime: f.runtime as unknown as ModelRuntime,
    secretStorage: { read: async () => undefined, write: async () => {}, remove: async () => {} },
    sessionId: options.sessionId ?? 'session-a', rootSessionId: options.rootSessionId ?? options.sessionId ?? 'session-a',
    allowedModels: options.allowedModels,
  });
  const service = instance.implementations.find(entry => entry.contract.key === MODELS_SERVICE.key)?.value as ModelsService;
  expect(service).toBeDefined();
  return { ...f, instance, service, parentSignal: controller.signal, parentLifetime: controller };
}

function fixture() {
  const cost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2,
    tiers: [{ inputTokensAbove: 100, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0.4 }] };
  const text: Model<Api> = Object.assign({
    id: 'text', name: 'Fixture text', provider: 'fixture', api: 'openai-responses',
    baseUrl: `https://user:${secret}@provider.invalid/v1?token=${secret}`, headers: { authorization: secret },
    input: ['text' as const], cost, reasoning: true, contextWindow: 1000, maxTokens: 100,
    thinkingLevelMap: { low: 'low', high: 'high' },
  }, { auth: { token: secret }, compat: { supportsMidConvoEffort: true, secret } });
  const image: ImageModel<ImageApi> = Object.assign({
    id: 'image', name: 'Fixture image', provider: 'fixture', api: 'openrouter-images', type: 'image' as const,
    baseUrl: `https://provider.invalid/${secret}`, headers: { authorization: secret },
    input: ['text' as const], output: ['image' as const], cost: { ...cost },
  }, { auth: { token: secret } });
  const message: AssistantMessage = {
    role: 'assistant', content: [{ type: 'text', text: 'Done' }], provider: text.provider, model: text.id, api: text.api,
    stopReason: 'stop', responseModel: 'actual-model', responseId: 'actual-response', timestamp: 1,
    usage: { input: 5, output: 8, cacheRead: 2, cacheWrite: 1, totalTokens: 16,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 } },
  };
  const images: AssistantImages = {
    provider: image.provider, model: image.id, api: image.api, output: [], stopReason: 'stop', timestamp: 1, usage: message.usage,
  };
  const runtime = {
    getAvailable: vi.fn<LocalModelsRuntime['getAvailable']>().mockResolvedValue([text]),
    getAvailableOfType: vi.fn<LocalModelsRuntime['getAvailableOfType']>().mockResolvedValue([image]),
    completeSimple: vi.fn<LocalModelsRuntime['completeSimple']>().mockResolvedValue(message),
    streamSimple: vi.fn<LocalModelsRuntime['streamSimple']>().mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
      return stream;
    }),
    generateImages: vi.fn<LocalModelsRuntime['generateImages']>().mockResolvedValue(images),
  };
  return { runtime, text, image, message, images };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
