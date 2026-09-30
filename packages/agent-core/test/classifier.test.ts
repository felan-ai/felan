import { describe, expect, it, vi } from 'vitest';
import type { ClassifierApi, ClassifierModel, ClassifierResult } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import * as core from '../src/index.js';
import { attachClassifierPreflight } from '../src/classifier/pi-classifier.js';

const model = {
  type: 'classifier', provider: 'typesafe', api: 'typesafe-system-one', id: 'jev-latest', name: 'Jev',
  baseUrl: 'https://api.typesafe.ai/v1/', contextWindow: 64_000, input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
} as ClassifierModel<ClassifierApi>;
const questions = {
  route: { type: 'choice', instructions: 'Route?', criteria: { simple: 'Simple', complex: 'Complex' } },
  discover: { type: 'bool', instructions: 'Explore?', criteria: { true: 'Yes', false: 'No' } },
  relevance: { type: 'score', instructions: 'Relevance?', criteria: ['Low', 'High'] },
} as const;

function backend() {
  return { classify: vi.fn<ModelRuntime['classify']>().mockImplementation(async (_model, context) => ({
    api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason: 'stop',
    answers: Object.fromEntries(Object.entries(context.questions).map(([id, question]) => [id,
      question.type === 'choice'
        ? { type: 'choice', choice: Object.keys(question.criteria)[0], confidence: 0.8 }
        : question.type === 'bool' ? { type: 'bool', probability: 0.8 } : { type: 'score', score: 0.6, confidence: 0.8 },
    ])),
  } as ClassifierResult)) };
}

describe('Pi-backed classifier', () => {
  it('exports one classification operation without legacy client APIs', async () => {
    for (const name of ['createJevClassifier', 'createJevClient', 'JevClientError']) {
      expect(Object.hasOwn(core, name)).toBe(false);
    }
    const service = backend();
    const classifier = core.createPiClassifier(service, model);
    expect(Object.keys(classifier)).toEqual(['canEvaluate', 'classify']);
    const result = await classifier.classify({ request: 'Task' }, questions);
    expect(result.answers).toEqual({
      route: { type: 'choice', choice: 'simple', confidence: 0.8 },
      discover: { type: 'bool', probability: 0.8 },
      relevance: { type: 'score', score: 0.6, confidence: 0.8 },
    });
    expect(result.metadata).toMatchObject({ provider: 'typesafe', model: 'jev-latest', usage: { requests: 1 } });
    expect(service.classify).toHaveBeenCalledWith(model, { state: { request: 'Task' }, questions }, {
      timeoutMs: 20_000, maxRetries: 0,
    });
  });

  it('passes caller cancellation to Pi and rejects late or aborted results', async () => {
    const service = backend();
    const classifier = core.createPiClassifier(service, model);
    const controller = new AbortController();
    await classifier.classify({}, questions, controller.signal);
    expect(service.classify.mock.calls[0]?.[2]?.signal).toBe(controller.signal);
    controller.abort();
    await expect(classifier.classify({}, questions, controller.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect(service.classify).toHaveBeenCalledOnce();
  });

  it('returns bounded generic errors instead of exposing provider error bodies', async () => {
    const service = backend();
    const classifier = core.createPiClassifier(service, model);
    service.classify.mockResolvedValueOnce({ api: model.api, provider: model.provider, model: model.id,
      timestamp: 1, answers: {}, stopReason: 'error', errorMessage: 'secret-key and private prompt' });
    await expect(classifier.classify({}, questions)).rejects.toMatchObject({
      code: 'request_failed', message: 'Classifier request failed',
    });
    service.classify.mockRejectedValueOnce(new Error('secret-key'));
    await expect(classifier.classify({}, questions)).rejects.toMatchObject({ message: 'Classifier request failed' });
    service.classify.mockResolvedValueOnce({ api: model.api, provider: model.provider, model: model.id,
      timestamp: 1, answers: {}, stopReason: 'aborted' });
    await expect(classifier.classify({}, questions)).rejects.toMatchObject({ code: 'aborted' });
  });

  it.each([
    { route: { type: 'choice', choice: 'unknown' } },
    { route: { type: 'choice', choice: 'simple', confidence: 2 } },
    { route: { type: 'choice', choice: 'simple', probabilities: { simple: -1 } } },
    { route: { type: 'bool', probability: 0.5 } },
  ])('rejects invalid choice answers: %j', async answers => {
    const service = backend();
    service.classify.mockResolvedValueOnce({ api: model.api, provider: model.provider, model: model.id,
      timestamp: 1, answers, stopReason: 'stop' } as ClassifierResult);
    await expect(core.createPiClassifier(service, model).classify({}, { route: questions.route }))
      .rejects.toMatchObject({ code: 'response_invalid' });
  });

  it.each([-1, 2, NaN])('rejects invalid probabilities: %s', async probability => {
    const service = backend();
    service.classify.mockResolvedValueOnce({ api: model.api, provider: model.provider, model: model.id,
      timestamp: 1, answers: { discover: { type: 'bool', probability } }, stopReason: 'stop' });
    await expect(core.createPiClassifier(service, model).classify({}, { discover: questions.discover }))
      .rejects.toMatchObject({ code: 'response_invalid' });
  });

  it('keeps admission bounds and rejects invalid state without invoking Pi', async () => {
    const service = backend();
    const classifier = core.createPiClassifier(service, model);
    expect(classifier.canEvaluate?.({}, questions)).toBe(true);
    expect(classifier.canEvaluate?.({ text: 'x'.repeat(31_000) }, {
      discover: { ...questions.discover, instructions: 'y'.repeat(2_000) },
    })).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const state of [cyclic, undefined, 'state', { text: 'x'.repeat(64_000) }]) {
      expect(classifier.canEvaluate?.(state, questions)).toBe(false);
      await expect(classifier.classify(state, questions)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(service.classify).not.toHaveBeenCalled();
  });

  it('batches by existing byte budgets without dropping questions or imposing a count cutoff', async () => {
    const service = backend();
    const classifier = core.createPiClassifier(service, model);
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [
      `q${index}`, { ...questions.discover, instructions: 'x'.repeat(900) },
    ]));
    const result = await classifier.classify({}, many);
    expect(Object.keys(result.answers)).toHaveLength(200);
    expect(service.classify.mock.calls.length).toBeGreaterThan(1);
    expect(result.metadata?.usage?.requests).toBe(service.classify.mock.calls.length);
    for (const [, context] of service.classify.mock.calls) {
      expect(Buffer.byteLength(JSON.stringify({ model: model.id, ...context }))).toBeLessThanOrEqual(64_000);
    }
    service.classify.mockClear();
    const short = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`q${index}`, questions.discover]));
    expect(Object.keys((await classifier.classify({}, short)).answers)).toHaveLength(300);
    expect(service.classify).toHaveBeenCalledOnce();
  });

  it('preserves reserved object-property names as ordinary question and answer IDs', async () => {
    const service = backend();
    const unusual = Object.fromEntries(['__proto__', 'constructor', 'toString'].map(id => [id, questions.discover]));
    const result = await core.createPiClassifier(service, model).classify({}, unusual);
    expect(Object.keys(result.answers)).toEqual(['__proto__', 'constructor', 'toString']);
    expect(Object.hasOwn(result.answers, '__proto__')).toBe(true);
    expect(result.answers.__proto__).toEqual({ type: 'bool', probability: 0.8 });
    expect(Object.keys(service.classify.mock.calls[0]![1].questions)).toEqual(Object.keys(unusual));
  });

  it('maps native token/cost metadata without treating absent catalog pricing as free inference', async () => {
    const service = backend();
    const answer = await service.classify(model, { state: {}, questions: {
      ...questions, relevance: { ...questions.relevance, criteria: [...questions.relevance.criteria] },
    } });
    service.classify.mockClear();
    service.classify.mockResolvedValue({ ...answer, usage: {
      input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    } });
    expect((await core.createPiClassifier(service, model).classify({}, questions)).metadata?.usage)
      .toEqual({ requests: 1, inputTokens: 10, outputTokens: 2, costUsd: 0.003 });
    const unpriced = { ...model, cost: { ...model.cost, input: 0, output: 0 } };
    expect((await core.createPiClassifier(service, unpriced).classify({}, questions)).metadata?.usage)
      .toEqual({ requests: 1, inputTokens: 10, outputTokens: 2 });
  });

  it('shares one root preflight across choice/bool calls and leaves custom classifiers untouched', async () => {
    vi.useFakeTimers();
    try {
      const service = backend();
      service.classify.mockImplementation(() => new Promise(() => {}));
      const classifier = core.createPiClassifier(service, model);
      const preflight = attachClassifierPreflight(classifier, core.createSilentLogger())!;
      expect(attachClassifierPreflight({ classify: vi.fn() }, core.createSilentLogger())).toBeUndefined();
      preflight.startNextTurn();
      const first = expect(classifier.classify({}, { route: questions.route })).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(1_500);
      const second = expect(classifier.classify({}, { discover: questions.discover })).rejects.toMatchObject({ code: 'timeout' });
      const third = expect(classifier.classify({}, { relevance: questions.relevance })).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(500);
      await Promise.all([first, second, third]);
      expect(service.classify.mock.calls.every(([, , options]) => options?.signal?.aborted)).toBe(true);
      preflight.finishPreflight();
      preflight.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
