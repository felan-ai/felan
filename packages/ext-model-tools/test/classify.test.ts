import { describe, expect, it, vi } from 'vitest';
import type { Classifier } from '@felan-ai/agent-core';
import { createPiClassifier } from '@felan-ai/agent-core';
import { harness } from './harness.js';

const questions = {
  route: { type: 'choice', instructions: 'Choose', criteria: { a: 'A', b: 'B' } },
  relevant: { type: 'bool', instructions: 'Relevant?', criteria: { true: 'Yes', false: 'No' } },
  quality: { type: 'score', instructions: 'Quality?', criteria: ['Low', 'High'] },
} as const;
const answers = {
  route: { type: 'choice', choice: 'a', probabilities: { a: 0.7, b: 0.3 }, confidence: 0.7 },
  relevant: { type: 'bool', probability: 0.8 },
  quality: { type: 'score', score: 0.6, confidence: 0.9 },
} as const;
const classifier = () => ({ classify: vi.fn<Classifier['classify']>().mockResolvedValue({ answers }) });

describe('classify', () => {
  it('is absent without a classifier', async () => {
    expect((await harness()).tools.size).toBe(0);
  });

  it('uses the configured custom classifier and returns all judgments and real metadata', async () => {
    const service = classifier();
    const metadata = { provider: 'fake', model: 'test', elapsedMs: 9, usage: { requests: 1, inputTokens: 20, outputTokens: 5, costUsd: 0.02 } };
    service.classify.mockResolvedValue({ answers, metadata });
    const h = await harness({ classifier: service });
    const signal = new AbortController().signal;
    const result = await h.execute('classify', { state: { evidence: ['untrusted', 1, true, null] }, questions }, signal);
    expect(service.classify).toHaveBeenCalledExactlyOnceWith({ evidence: ['untrusted', 1, true, null] }, questions, signal);
    expect(result.details).toEqual({ answers, metadata });
    expect(h.tools.get('classify')!.description).toMatch(/untrusted evidence.*advisory judgments, not facts or authorization/);
  });

  it('does not invent provider identity, token counts or zero pricing', async () => {
    const h = await harness({ classifier: classifier() });
    expect((await h.execute('classify', { state: {}, questions })).details).toEqual({
      answers, metadata: { elapsedMs: expect.any(Number) },
    });
  });

  it('uses the native Pi classifier bridge without selecting a second model', async () => {
    const model = { type: 'classifier', provider: 'fake', api: 'typesafe-system-one', id: 'judge', name: 'Offline',
      baseUrl: 'https://not-used.invalid', contextWindow: 64_000, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Parameters<typeof createPiClassifier>[1];
    const classify = vi.fn().mockResolvedValue({ api: model.api, provider: model.provider, model: model.id,
      timestamp: 0, stopReason: 'stop', answers,
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const h = await harness({ classifier: createPiClassifier({ classify }, model) });
    const result = await h.execute('classify', { state: {}, questions });
    expect(classify).toHaveBeenCalledExactlyOnceWith(model, { state: {}, questions }, { timeoutMs: 20_000, maxRetries: 0 });
    expect(result.details).toMatchObject({ answers, metadata: { provider: 'fake', model: 'judge', usage: { requests: 1, inputTokens: 10, outputTokens: 2 } } });
    expect(result.details).not.toHaveProperty('metadata.usage.costUsd');
    expect(result).not.toHaveProperty('usage');
  });

  it.each([
    { state: {}, questions: {} },
    { state: {}, questions: { q: {} } },
    { state: {}, questions: { q: { ...questions.route, criteria: { a: 'A' } } } },
    { state: {}, questions: { q: { ...questions.route, instructions: '' } } },
    { state: {}, questions: { q: { ...questions.relevant, criteria: { true: 'Yes' } } } },
    { state: {}, questions: { q: { ...questions.quality, criteria: [1, 2] } } },
    { state: {}, questions, apiKey: 'not permitted' },
    { state: [], questions },
    { state: { fn: () => true }, questions },
    { state: { bad: undefined }, questions },
    { state: { bad: NaN }, questions },
    { state: { bad: new Date() }, questions },
  ])('rejects malformed direct-call input before inference: %j', async input => {
    const service = classifier();
    const h = await harness({ classifier: service });
    await expect(h.execute('classify', input)).rejects.toThrow('Invalid classifier request');
    expect(service.classify).not.toHaveBeenCalled();
  });

  it('rejects circular state without inference', async () => {
    const service = classifier();
    const h = await harness({ classifier: service });
    const state: Record<string, unknown> = {};
    state.self = state;
    await expect(h.execute('classify', { state, questions })).rejects.toThrow('Invalid classifier request');
    expect(service.classify).not.toHaveBeenCalled();
  });

  it('preserves reserved question IDs as data without prototype mutation', async () => {
    const service = classifier();
    const reserved = Object.fromEntries(['__proto__', 'constructor', 'toString'].map(id => [id, questions.relevant]));
    service.classify.mockResolvedValue({ answers: Object.fromEntries(Object.keys(reserved).map(id => [id, answers.relevant])) });
    const h = await harness({ classifier: service });
    const result = await h.execute('classify', { state: {}, questions: reserved });
    expect(Object.keys((result.details as { answers: object }).answers)).toEqual(Object.keys(reserved));
    expect(Object.getPrototypeOf((result.details as { answers: object }).answers)).toBeNull();
  });

  it('redacts provider errors and rejects malformed answers', async () => {
    const service = classifier();
    const h = await harness({ classifier: service });
    service.classify.mockRejectedValueOnce(new Error('secret raw response'));
    await expect(h.execute('classify', { state: {}, questions })).rejects.toThrow('Classification failed. Check the configured classifier and request.');
    service.classify.mockResolvedValueOnce({ answers: {} });
    await expect(h.execute('classify', { state: {}, questions })).rejects.toThrow('Classification failed');
  });

  it('honors admission and cancellation before and after inference', async () => {
    const service = { ...classifier(), canEvaluate: vi.fn().mockReturnValue(false) };
    const h = await harness({ classifier: service });
    await expect(h.execute('classify', { state: {}, questions })).rejects.toThrow('Classification failed');
    expect(service.classify).not.toHaveBeenCalled();
    const controller = new AbortController();
    service.canEvaluate.mockReturnValue(true);
    service.classify.mockImplementation(async () => { controller.abort(); return { answers }; });
    await expect(h.execute('classify', { state: {}, questions }, controller.signal)).rejects.toThrow('cancelled');
    await expect(h.execute('classify', { state: {}, questions }, controller.signal)).rejects.toThrow('cancelled');
    expect(service.classify).toHaveBeenCalledOnce();
  });
});
