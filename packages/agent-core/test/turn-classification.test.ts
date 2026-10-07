import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClassifierApi, ClassifierModel, ClassifierResult } from '@earendil-works/pi-ai';
import type { ExtensionContext, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { SessionManager } from '../src/index.js';
import { createLogger, createSilentLogger, type LogRecord } from '../src/logger.js';
import { createPiClassifier } from '../src/classifier/pi-classifier.js';
import { collectClassifierSessionEvidence } from '../src/classifier/session-evidence.js';
import { createTurnClassificationRegistry } from '../src/classifier/turn-classification.js';
import type { TurnClassificationContribution, TurnClassificationPreparation } from '../src/classifier/turn-classification.js';
import type { Classifier } from '../src/classifier/types.js';

const model = { provider: 'openai', id: 'test-model', api: 'openai-responses' };
const request = { prompt: 'Fix the build', imageCount: 0 };
const bool = {
  type: 'bool', instructions: 'Explore?', criteria: { true: 'Yes', false: 'No' },
} as const;
const choice = {
  type: 'choice', instructions: 'Effort?', criteria: { low: 'Small task', high: 'Complex task' },
} as const;
const score = { type: 'score', instructions: 'Risk?', criteria: ['Low', 'High'] } as const;
const metadata = { provider: 'typesafe', model: 'jev-test', usage: { requests: 1 } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((release) => { resolve = release; });
  return { promise, resolve };
}

function harness() {
  const records: LogRecord[] = [];
  const current = { model: { ...model }, sessionManager: SessionManager.inMemory('/workspace') };
  const ctx = current as unknown as ExtensionContext;
  const classify = vi.fn<Classifier['classify']>().mockImplementation(async (_state, questions) => ({
    answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id,
      question.type === 'bool' ? { type: 'bool', probability: 0.8 }
        : question.type === 'choice' ? { type: 'choice', choice: 'high', confidence: 0.9 }
          : { type: 'score', score: 0.6, confidence: 0.7 },
    ])),
    metadata,
  }));
  const classifier: Classifier = { classify };
  const registry = createTurnClassificationRegistry(classifier, createLogger({
    level: 'debug', destination: { write: (record) => { records.push(record); } },
  }));
  cleanups.push(() => registry.dispose());
  return { registry, classify, current, ctx, records };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

describe('turn classification registry', () => {
  it('retains shared answers across an owned promotion but rejects unowned model changes', async () => {
    const { classify, current, ctx } = harness();
    let owned = false;
    const registry = createTurnClassificationRegistry({ classify }, createSilentLogger(), () => owned);
    cleanups.push(() => registry.dispose());
    registry.register({ id: 'discovery', prepare: () => ({ questions: { needed: bool } }) });
    registry.start(request, ctx);
    expect(await registry.result('discovery', request, ctx)).toBeDefined();
    owned = true;
    current.model = { ...model, id: 'promoted-model' };
    expect(await registry.result('discovery', request, ctx)).toBeDefined();
    expect(classify).toHaveBeenCalledOnce();
    owned = false;
    expect(await registry.result('discovery', request, ctx)).toBeUndefined();
  });

  it('freezes producer registration until reload resets the registry', async () => {
    const { registry, ctx } = harness();
    registry.start(request, ctx);
    expect(() => registry.register({ id: 'late', prepare: () => undefined })).toThrow('initialization');
    registry.finish();
    expect(() => registry.register({ id: 'late', prepare: () => undefined })).toThrow('initialization');
    registry.reset();
    expect(() => registry.register({ id: 'fresh', prepare: () => undefined })).not.toThrow();
  });

  it('does not prepare or classify from result consumption before a turn starts', async () => {
    const { registry, classify, ctx } = harness();
    const prepare = vi.fn(() => ({ questions: { decision: bool } }));
    registry.register({ id: 'effort', prepare });
    expect(await registry.result('effort', request, ctx)).toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  it('aggregates three producers into one call and restores their original answer keys', async () => {
    const { registry, classify, current, ctx } = harness();
    current.sessionManager.appendMessage({
      role: 'user', content: [{ type: 'text', text: 'Earlier build failure' }], timestamp: 1,
    });
    const effort = vi.fn(() => ({ questions: { decision: choice }, state: { levels: ['low', 'high'] } }));
    const discovery = vi.fn(() => ({ questions: { decision: bool }, state: { cwd: '/workspace' } }));
    const planning = vi.fn(() => ({ questions: { decision: score }, state: { enabled: true } }));
    registry.register({ id: 'effort', prepare: effort });
    registry.register({ id: 'discovery', prepare: discovery });
    registry.register({ id: 'planning', prepare: planning });

    registry.start(request, ctx);
    const results = await Promise.all(['effort', 'discovery', 'planning'].map((id) => registry.result(id, request, ctx)));

    expect(classify).toHaveBeenCalledOnce();
    expect(classify.mock.calls[0]?.[0]).toEqual({
      request: request.prompt, image_count: 0,
      session: collectClassifierSessionEvidence(current.sessionManager),
      extensions: {
        effort: { levels: ['low', 'high'] }, discovery: { cwd: '/workspace' }, planning: { enabled: true },
      },
    });
    expect(classify.mock.calls[0]?.[1]).toEqual({
      'effort:decision': choice, 'discovery:decision': bool, 'planning:decision': score,
    });
    expect(results).toEqual([
      { answers: { decision: { type: 'choice', choice: 'high', confidence: 0.9 } }, metadata },
      { answers: { decision: { type: 'bool', probability: 0.8 } }, metadata },
      { answers: { decision: { type: 'score', score: 0.6, confidence: 0.7 } }, metadata },
    ]);
    for (const prepare of [effort, discovery, planning]) {
      expect(prepare).toHaveBeenCalledOnce();
      expect(prepare).toHaveBeenCalledWith({
        ...request, session: collectClassifierSessionEvidence(current.sessionManager),
      }, ctx, expect.any(AbortSignal));
    }
    expect(await registry.result('effort', request, ctx)).toEqual(results[0]);
    expect(await registry.result('unregistered', request, ctx)).toBeUndefined();
    expect(classify).toHaveBeenCalledOnce();
  });

  it.each(['', ' ', 'invalid:id'])('rejects invalid producer ID %j', (id) => {
    const { registry } = harness();
    expect(() => registry.register({ id, prepare: () => ({ questions: { decision: bool } }) })).toThrow();
  });

  it('sends a small three-producer aggregate through Pi as exactly one mocked provider call', async () => {
    const classifierModel = {
      type: 'classifier', provider: 'typesafe', api: 'typesafe-system-one', id: 'jev-test', name: 'Jev',
      baseUrl: 'https://api.typesafe.ai/v1/', contextWindow: 64_000, input: ['text'],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    } as ClassifierModel<ClassifierApi>;
    const models = { classify: vi.fn<ModelRuntime['classify']>().mockResolvedValue({
      api: classifierModel.api, provider: classifierModel.provider, model: classifierModel.id,
      timestamp: 1, stopReason: 'stop', answers: {
        'effort:decision': { type: 'choice', choice: 'high', probabilities: { low: 0.1, high: 0.9 }, confidence: 0.9 },
        'discovery:decision': { type: 'bool', probability: 0.8 },
        'planning:decision': { type: 'score', score: 0.6, confidence: 0.7 },
      },
    } as ClassifierResult) };
    const ctx = { model, sessionManager: SessionManager.inMemory('/workspace') } as unknown as ExtensionContext;
    const registry = createTurnClassificationRegistry(createPiClassifier(models, classifierModel), createSilentLogger());
    cleanups.push(() => registry.dispose());
    registry.register({ id: 'effort', prepare: () => ({ questions: { decision: choice }, state: { level: 'high' } }) });
    registry.register({ id: 'discovery', prepare: () => ({ questions: { decision: bool }, state: { enabled: true } }) });
    registry.register({ id: 'planning', prepare: () => ({ questions: { decision: score }, state: { phase: 'entry' } }) });
    registry.start(request, ctx);
    const results = await Promise.all(['effort', 'discovery', 'planning'].map((id) => registry.result(id, request, ctx)));
    expect(models.classify).toHaveBeenCalledOnce();
    expect(models.classify).toHaveBeenCalledWith(classifierModel, {
      state: {
        request: request.prompt, image_count: 0, session: { conversation: [], tool_activity: [] },
        extensions: { effort: { level: 'high' }, discovery: { enabled: true }, planning: { phase: 'entry' } },
      },
      questions: { 'effort:decision': choice, 'discovery:decision': bool, 'planning:decision': score },
    }, { signal: expect.any(AbortSignal), timeoutMs: 20_000, maxRetries: 0 });
    expect(results.map((result) => result?.answers)).toEqual([
      { decision: { type: 'choice', choice: 'high', probabilities: { low: 0.1, high: 0.9 }, confidence: 0.9 } },
      { decision: { type: 'bool', probability: 0.8 } },
      { decision: { type: 'score', score: 0.6, confidence: 0.7 } },
    ]);
    for (const result of results) expect(result?.metadata).toMatchObject(metadata);
  });

  it('rejects duplicate producer IDs without replacing the first contribution', async () => {
    const { registry, ctx } = harness();
    const first = vi.fn(() => ({ questions: { decision: bool } }));
    const second = vi.fn(() => ({ questions: { decision: choice } }));
    registry.register({ id: 'effort', prepare: first });
    expect(() => registry.register({ id: 'effort', prepare: second })).toThrow();
    registry.start(request, ctx);
    expect((await registry.result('effort', request, ctx))?.answers.decision).toEqual({ type: 'bool', probability: 0.8 });
    expect(second).not.toHaveBeenCalled();
  });

  it('isolates skipped, failing and invalid preparations from an eligible producer', async () => {
    const { registry, classify, ctx, records } = harness();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    registry.register({ id: 'skipped', prepare: () => undefined });
    registry.register({ id: 'failed', prepare: async () => { throw new Error('PRIVATE_PREPARATION_ERROR'); } });
    registry.register({ id: 'invalid-state', prepare: () => ({ questions: { decision: bool }, state: cyclic }) });
    registry.register({
      id: 'invalid-question',
      prepare: () => ({ questions: { decision: { ...bool, criteria: {} } } } as unknown as TurnClassificationPreparation),
    });
    registry.register({ id: 'empty', prepare: () => ({ questions: {} }) });
    registry.register({ id: 'eligible', prepare: () => ({ questions: { decision: bool } }) });

    registry.start(request, ctx);
    const ids = ['skipped', 'failed', 'invalid-state', 'invalid-question', 'empty', 'eligible'];
    const results = await Promise.all(ids.map((id) => registry.result(id, request, ctx)));
    expect(results.slice(0, -1)).toEqual(Array.from({ length: 5 }, () => undefined));
    expect(results.at(-1)?.answers).toEqual({ decision: { type: 'bool', probability: 0.8 } });
    expect(classify).toHaveBeenCalledOnce();
    expect(classify.mock.calls[0]?.[1]).toEqual({ 'eligible:decision': bool });
    expect(JSON.stringify(records)).not.toContain('PRIVATE_PREPARATION_ERROR');
  });

  it('does not call the classifier when there are no eligible questions', async () => {
    const { registry, classify, ctx } = harness();
    registry.register({ id: 'skipped', prepare: () => undefined });
    registry.register({ id: 'failed', prepare: () => { throw new Error('Failed preparation'); } });
    registry.register({ id: 'empty', prepare: () => ({ questions: {} }) });
    registry.start(request, ctx);
    expect(await registry.result('empty', request, ctx)).toBeUndefined();
    expect(classify).not.toHaveBeenCalled();
  });

  it('does not call the classifier with no registered contributions', async () => {
    const { registry, classify, ctx } = harness();
    registry.start(request, ctx);
    expect(await registry.result('effort', request, ctx)).toBeUndefined();
    expect(classify).not.toHaveBeenCalled();
  });

  it('returns undefined to all producers when the combined request fails', async () => {
    const { registry, classify, ctx, records } = harness();
    classify.mockRejectedValue(new Error('PRIVATE_PROVIDER_ERROR'));
    registry.register({ id: 'effort', prepare: () => ({ questions: { decision: choice } }) });
    registry.register({ id: 'discovery', prepare: () => ({ questions: { decision: bool } }) });
    registry.start(request, ctx);
    expect(await Promise.all(['effort', 'discovery'].map((id) => registry.result(id, request, ctx))))
      .toEqual([undefined, undefined]);
    expect(classify).toHaveBeenCalledOnce();
    expect(JSON.stringify(records)).not.toContain('PRIVATE_PROVIDER_ERROR');
  });

  it('does not deliver partial results when a combined answer is invalid', async () => {
    const { registry, classify, ctx } = harness();
    classify.mockResolvedValue({ answers: {
      'effort:decision': { type: 'choice', choice: 'high' },
      'discovery:decision': { type: 'bool', probability: 2 },
    } });
    registry.register({ id: 'effort', prepare: () => ({ questions: { decision: choice } }) });
    registry.register({ id: 'discovery', prepare: () => ({ questions: { decision: bool } }) });
    registry.start(request, ctx);
    expect(await Promise.all(['effort', 'discovery'].map((id) => registry.result(id, request, ctx))))
      .toEqual([undefined, undefined]);
    expect(classify).toHaveBeenCalledOnce();
  });

  it('supersedes an old prompt and discards its late classifier response', async () => {
    const { registry, classify, ctx } = harness();
    const old = deferred<Awaited<ReturnType<Classifier['classify']>>>();
    const entered = deferred<void>();
    classify.mockImplementationOnce(() => { entered.resolve(); return old.promise; });
    const prepare = vi.fn(() => ({ questions: { decision: bool } }));
    registry.register({ id: 'effort', prepare });
    registry.start(request, ctx);
    const oldResult = registry.result('effort', request, ctx);
    await entered.promise;
    const oldSignal = classify.mock.calls[0]?.[2];
    const next = { ...request, prompt: 'Fix the new failure' };
    registry.start(next, ctx);
    expect(oldSignal?.aborted).toBe(true);
    expect(await oldResult).toBeUndefined();
    expect((await registry.result('effort', next, ctx))?.answers.decision).toEqual({ type: 'bool', probability: 0.8 });
    old.resolve({ answers: { 'effort:decision': { type: 'bool', probability: 0.1 } } });
    expect((await registry.result('effort', next, ctx))?.answers.decision).toEqual({ type: 'bool', probability: 0.8 });
    expect(await registry.result('effort', request, ctx)).toBeUndefined();
    expect(classify).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it.each(['prompt', 'images', 'model', 'provider', 'session'] as const)(
    'does not reuse completed results after a %s change', async (change) => {
      const { registry, classify, current, ctx } = harness();
      registry.register({ id: 'effort', prepare: () => ({ questions: { decision: bool } }) });
      registry.start(request, ctx);
      expect(await registry.result('effort', request, ctx)).toBeDefined();
      let next = request;
      if (change === 'prompt') next = { ...request, prompt: 'Another request' };
      if (change === 'images') next = { ...request, imageCount: 1 };
      if (change === 'model') current.model = { ...model, id: 'another-model' };
      if (change === 'provider') current.model = { ...model, provider: 'another-provider' };
      if (change === 'session') current.sessionManager = SessionManager.inMemory('/workspace');
      expect(await registry.result('effort', next, ctx)).toBeUndefined();
      expect(classify).toHaveBeenCalledOnce();
    },
  );

  it.each(['model', 'session'] as const)('guards in-flight results against a %s change', async (change) => {
    const { registry, classify, current, ctx } = harness();
    const response = deferred<Awaited<ReturnType<Classifier['classify']>>>();
    const entered = deferred<void>();
    classify.mockImplementationOnce(() => { entered.resolve(); return response.promise; });
    registry.register({ id: 'effort', prepare: () => ({ questions: { decision: bool } }) });
    registry.start(request, ctx);
    const result = registry.result('effort', request, ctx);
    await entered.promise;
    if (change === 'model') current.model = { ...model, id: 'another-model' };
    else current.sessionManager = SessionManager.inMemory('/workspace');
    response.resolve({ answers: { 'effort:decision': { type: 'bool', probability: 0.8 } } });
    expect(await result).toBeUndefined();
    expect(await registry.result('effort', request, ctx)).toBeUndefined();
  });

  it('uses one two-second deadline for both preparation and classification', async () => {
    vi.useFakeTimers();
    const { registry, classify, ctx } = harness();
    const preparation = deferred<TurnClassificationPreparation>();
    const response = deferred<Awaited<ReturnType<Classifier['classify']>>>();
    const prepare = vi.fn(() => preparation.promise);
    classify.mockReturnValue(response.promise);
    registry.register({ id: 'effort', prepare });
    registry.start(request, ctx);
    const result = registry.result('effort', request, ctx);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(classify).not.toHaveBeenCalled();
    preparation.resolve({ questions: { decision: bool } });
    await vi.advanceTimersByTimeAsync(0);
    expect(classify).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBeUndefined();
    expect(classify.mock.calls[0]?.[2]?.aborted).toBe(true);
    expect(prepare).toHaveBeenCalledWith(expect.anything(), ctx, expect.objectContaining({ aborted: true }));
    response.resolve({ answers: { 'effort:decision': { type: 'bool', probability: 0.8 } } });
    expect(await registry.result('effort', request, ctx)).toBeUndefined();
  });

  it('does not classify a preparation that resolves after the deadline', async () => {
    vi.useFakeTimers();
    const { registry, classify, ctx } = harness();
    const preparation = deferred<TurnClassificationPreparation>();
    registry.register({ id: 'effort', prepare: () => preparation.promise });
    registry.start(request, ctx);
    const result = registry.result('effort', request, ctx);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toBeUndefined();
    preparation.resolve({ questions: { decision: bool } });
    await vi.advanceTimersByTimeAsync(0);
    expect(classify).not.toHaveBeenCalled();
  });

  it.each(['finish', 'dispose'] as const)('%s aborts pending classification and rejects late answers', async (operation) => {
    const { registry, classify, ctx } = harness();
    const response = deferred<Awaited<ReturnType<Classifier['classify']>>>();
    const entered = deferred<void>();
    classify.mockImplementationOnce(() => { entered.resolve(); return response.promise; });
    registry.register({ id: 'effort', prepare: () => ({ questions: { decision: bool } }) });
    registry.start(request, ctx);
    const result = registry.result('effort', request, ctx);
    await entered.promise;
    registry[operation]();
    expect(classify.mock.calls[0]?.[2]?.aborted).toBe(true);
    expect(await result).toBeUndefined();
    response.resolve({ answers: { 'effort:decision': { type: 'bool', probability: 0.8 } } });
    expect(await registry.result('effort', request, ctx)).toBeUndefined();
  });

  it('reset aborts the old pass, clears contributions and permits registration on reload', async () => {
    const { registry, classify, ctx } = harness();
    const response = deferred<Awaited<ReturnType<Classifier['classify']>>>();
    const entered = deferred<void>();
    classify.mockImplementationOnce(() => { entered.resolve(); return response.promise; });
    const oldPrepare = vi.fn(() => ({ questions: { stale: bool } }));
    registry.register({ id: 'effort', prepare: oldPrepare });
    registry.start(request, ctx);
    const oldResult = registry.result('effort', request, ctx);
    await entered.promise;
    registry.reset();
    expect(classify.mock.calls[0]?.[2]?.aborted).toBe(true);
    expect(await oldResult).toBeUndefined();
    registry.start(request, ctx);
    expect(await registry.result('effort', request, ctx)).toBeUndefined();
    expect(classify).toHaveBeenCalledOnce();
    registry.reset();
    const newPrepare = vi.fn(() => ({ questions: { fresh: bool } }));
    registry.register({ id: 'effort', prepare: newPrepare });
    registry.start(request, ctx);
    expect((await registry.result('effort', request, ctx))?.answers).toEqual({ fresh: { type: 'bool', probability: 0.8 } });
    response.resolve({ answers: { 'effort:stale': { type: 'bool', probability: 0.1 } } });
    expect((await registry.result('effort', request, ctx))?.answers).toEqual({ fresh: { type: 'bool', probability: 0.8 } });
    expect(oldPrepare).toHaveBeenCalledOnce();
    expect(newPrepare).toHaveBeenCalledOnce();
    expect(classify).toHaveBeenCalledTimes(2);
    expect(classify.mock.calls[1]?.[1]).toEqual({ 'effort:fresh': bool });
  });

  it('redacts credentials and excludes images and tool output from shared classifier evidence and logs', async () => {
    const { registry, classify, current, ctx, records } = harness();
    current.sessionManager.appendMessage({
      role: 'user', content: [
        { type: 'text', text: 'Inspect token sk-abcdefghijklmnopqrstuvwxyz' },
        { type: 'image', mimeType: 'image/png', data: 'PRIVATE_IMAGE_DATA' },
      ], timestamp: 1,
    });
    current.sessionManager.appendMessage({
      role: 'assistant', content: [{
        type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pnpm test --token Bearer abcdefghijklmnopqrstuvwxyz' },
      }], timestamp: 2,
    } as unknown as Parameters<SessionManager['appendMessage']>[0]);
    current.sessionManager.appendMessage({
      role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', isError: false,
      content: [{ type: 'text', text: 'PRIVATE_TOOL_OUTPUT' }], timestamp: 3,
    });
    const prepare = vi.fn<TurnClassificationContribution['prepare']>(() => ({ questions: { decision: bool } }));
    registry.register({ id: 'effort', prepare });
    const privateRequest = { prompt: 'Fix with api_key=PRIVATE_API_KEY and sk-abcdefghijklmnopqrstuvwxyz', imageCount: 1 };
    registry.start(privateRequest, ctx);
    expect(await registry.result('effort', privateRequest, ctx)).toBeDefined();
    const state = classify.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(state.image_count).toBe(1);
    expect(state.session).toMatchObject({ tool_activity: [{ tool: 'bash', result: 'ok' }] });
    expect(JSON.stringify(state)).not.toMatch(/PRIVATE_API_KEY|abcdefghijklmnopqrstuvwxyz|PRIVATE_IMAGE_DATA|PRIVATE_TOOL_OUTPUT/u);
    expect(JSON.stringify(prepare.mock.calls[0]?.[0])).not.toMatch(/PRIVATE_API_KEY|abcdefghijklmnopqrstuvwxyz|PRIVATE_IMAGE_DATA|PRIVATE_TOOL_OUTPUT/u);
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE_API_KEY|abcdefghijklmnopqrstuvwxyz|PRIVATE_IMAGE_DATA|PRIVATE_TOOL_OUTPUT/u);
  });
});
