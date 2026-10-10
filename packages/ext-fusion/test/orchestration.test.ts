import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FUSION_CONFIG } from '../src/config.js';
import type { FusionModelRequest } from '../src/contracts.js';
import type { FusionModelRuntime } from '../src/models.js';
import { runFusion, synthesizeFusion } from '../src/orchestration.js';

function runtime(handler?: (request: FusionModelRequest) => Promise<string>) {
  const calls: FusionModelRequest[] = [];
  const result: FusionModelRuntime = {
    participants: ['one/model', 'two/model', 'three/model'].map((reference) => ({ reference, label: reference })),
    fusionModel: { reference: 'one/model', label: 'one/model' },
    resolve(reference) {
      return reference === 'one/model' ? { reference, label: reference } : undefined;
    },
    async complete(request) {
      calls.push(request);
      const text = await (handler?.(request) ?? Promise.resolve(`answer from ${request.model.reference}`));
      return {
        text,
        model: request.model.reference,
        durationMs: 12,
        usage: { input: 3, output: 4, totalTokens: 7, estimatedCost: 0.02 },
      };
    },
  };
  return { runtime: result, calls };
}

describe('Fusion orchestration', () => {
  it('runs bounded participant requests on identical input, compares answers, and keeps synthesis explicit', async () => {
    const { runtime: models, calls } = runtime();
    let active = 0;
    let maximumActive = 0;
    const tracked: FusionModelRuntime = {
      ...models,
      async complete(request) {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active--;
        return models.complete(request);
      },
    };
    const review = await runFusion({
      prompt: '  Same question  ', runtime: tracked,
      config: { ...DEFAULT_FUSION_CONFIG, concurrency: 2 }, signal: new AbortController().signal,
    });
    expect(maximumActive).toBe(2);
    expect(calls.slice(0, 3).map(({ prompt }) => prompt)).toEqual(['Same question', 'Same question', 'Same question']);
    expect(calls[3]?.prompt).toContain('Agreements');
    expect(calls[3]?.prompt).toContain('2–5 short bullets');
    expect(calls[3]?.prompt).toContain('Blind spots');
    expect(calls[3]?.prompt).toContain('<source_answer>');
    expect(calls[3]?.prompt).toContain('Agreement is not proof');
    expect(review.answers).toHaveLength(3);
    expect(review.comparison?.usage?.estimatedCost).toBe(0.02);
    expect(review.fused).toBeUndefined();
    const { comparison: _comparison, ...uncomparedReview } = review;
    await expect(synthesizeFusion(uncomparedReview, models, DEFAULT_FUSION_CONFIG, new AbortController().signal))
      .rejects.toThrow('Complete the model comparison');
    expect(calls).toHaveLength(4);
    const fused = await synthesizeFusion(review, models, DEFAULT_FUSION_CONFIG, new AbortController().signal);
    expect(calls[4]?.prompt).toContain('Same question');
    expect(calls[4]?.prompt).toContain('answer from two/model');
    expect(calls[4]?.prompt).toContain('Prior comparison');
    expect(calls[4]?.prompt).toContain('Use readable Markdown sections');
    expect(fused.text).toContain('answer from');
  });

  it('continues after a participant failure when at least two answers succeed', async () => {
    const { runtime: models } = runtime(async ({ model }) => {
      if (model.reference === 'two/model') throw new Error('provider unavailable');
      return `response ${model.reference}`;
    });
    const review = await runFusion({ prompt: 'question', runtime: models, config: DEFAULT_FUSION_CONFIG, signal: new AbortController().signal });
    expect(review.answers.map(({ model }) => model)).toEqual(['one/model', 'three/model']);
    expect(review.failures).toEqual([{ model: 'two/model', message: 'provider unavailable' }]);
    expect(review.comparison).toBeDefined();
  });

  it('requires two successful answers and preserves original results if comparison fails', async () => {
    const failure = vi.fn(async ({ model }: FusionModelRequest) => {
      if (model.reference !== 'three/model') throw new Error('panel failure');
      return 'only one';
    });
    const { runtime: oneAnswer } = runtime(failure);
    await expect(runFusion({ prompt: 'question', runtime: oneAnswer, config: DEFAULT_FUSION_CONFIG, signal: new AbortController().signal }))
      .rejects.toThrow('at least two successful');

    const { runtime: models } = runtime(async ({ prompt }) => {
      if (prompt.includes('Compare independent')) throw new Error('comparison unavailable');
      return 'source answer';
    });
    await expect(runFusion({ prompt: 'question', runtime: models, config: DEFAULT_FUSION_CONFIG, signal: new AbortController().signal }))
      .rejects.toMatchObject({ name: 'FusionComparisonError', review: { answers: expect.any(Array) } });
  });

  it('bounds retained output and propagates cancellation without turning it into partial success', async () => {
    const { runtime: models } = runtime(async ({ signal, model }) => {
      if (signal.aborted) throw new Error('cancelled');
      return model.reference === 'one/model' ? 'x'.repeat(1500) : `answer ${model.reference}`;
    });
    const review = await runFusion({ prompt: 'question', runtime: models, config: { ...DEFAULT_FUSION_CONFIG, maxOutputChars: 1000 }, signal: new AbortController().signal });
    expect(review.answers[0]?.text).toHaveLength(1000);
    expect(review.answers[0]?.truncated).toBe(true);

    const controller = new AbortController();
    const pending = runtime(({ signal }) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('provider abort')), { once: true });
    }));
    const aborted = runFusion({ prompt: 'question', runtime: pending.runtime, config: DEFAULT_FUSION_CONFIG, signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toThrow('cancelled');
  });

  it('rejects overlong prompts or a missing comparison model before participant calls', async () => {
    const { runtime: models, calls } = runtime();
    const options = { prompt: 'x'.repeat(20_001), runtime: models, config: DEFAULT_FUSION_CONFIG, signal: new AbortController().signal };
    await expect(runFusion(options)).rejects.toThrow('character limit');
    expect(calls).toHaveLength(0);
    const { fusionModel: _fusionModel, ...withoutFusionModel } = models;
    await expect(runFusion({ ...options, prompt: 'short', runtime: withoutFusionModel })).rejects.toThrow('comparison and fusion model');
    expect(calls).toHaveLength(0);
  });
});
