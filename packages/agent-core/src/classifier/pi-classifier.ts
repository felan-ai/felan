import type { ClassifierApi, ClassifierModel, ClassifierResult } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Logger } from '../logger.js';
import { ClassifierError } from './error.js';
import { createClassifierPreflight } from './preflight.js';
import type { Classifier, ClassifierAnswers, ClassifierUsage } from './types.js';
import { prepareClassifierRequest, validateClassifierAnswers } from './validation.js';

const preflights = new WeakMap<Classifier, ReturnType<typeof createClassifierPreflight>>();
const managedClassifiers = new WeakSet<Classifier>();

export function attachClassifierPreflight(classifier: Classifier, logger: Logger) {
  if (!managedClassifiers.has(classifier)) return undefined;
  const preflight = createClassifierPreflight(logger);
  preflights.set(classifier, preflight);
  return preflight;
}

export function createPiClassifier(
  models: Pick<ModelRuntime, 'classify'>,
  model: ClassifierModel<ClassifierApi>,
): Classifier {
  const classifier: Classifier = {
    canEvaluate(state, questions) {
      try {
        prepareClassifierRequest(model.id, state, questions);
        return true;
      } catch {
        return false;
      }
    },
    async classify(state, questions, signal) {
      const started = Date.now();
      const run = async (activeSignal?: AbortSignal) => {
        const request = prepareClassifierRequest(model.id, state, questions);
        const answers: Record<string, ClassifierAnswers[string]> = Object.create(null);
        const usage: { requests: number; inputTokens?: number; outputTokens?: number; costUsd?: number } = { requests: 0 };
        for (const batch of request.batches) {
          if (activeSignal?.aborted) throw new ClassifierError('aborted', 'Classifier request was aborted');
          let result: ClassifierResult;
          try {
            result = await models.classify(model, { state: request.state, questions: batch }, {
              ...(activeSignal === undefined ? {} : { signal: activeSignal }), timeoutMs: 20_000, maxRetries: 0,
            });
          } catch {
            throw new ClassifierError(activeSignal?.aborted ? 'aborted' : 'request_failed', 'Classifier request failed');
          }
          if (activeSignal?.aborted || result.stopReason === 'aborted') {
            throw new ClassifierError('aborted', 'Classifier request was aborted');
          }
          if (result.stopReason !== 'stop') throw new ClassifierError('request_failed', 'Classifier request failed');
          Object.assign(answers, validateClassifierAnswers(batch, result.answers));
          usage.requests += 1;
          if (result.usage) {
            addUsage(usage, 'inputTokens', result.usage.input);
            addUsage(usage, 'outputTokens', result.usage.output);
            if (model.cost.input > 0 || model.cost.output > 0) addUsage(usage, 'costUsd', result.usage.cost.total);
          }
        }
        return { answers, metadata: { provider: model.provider, model: model.id, usage, elapsedMs: Date.now() - started } };
      };
      const preflight = preflights.get(classifier);
      return preflight ? preflight.run(Object.keys(questions).join(','), run, signal) : run(signal);
    },
  };
  managedClassifiers.add(classifier);
  return classifier;
}

function addUsage(usage: { requests: number; inputTokens?: number; outputTokens?: number; costUsd?: number },
  key: Exclude<keyof ClassifierUsage, 'requests'>, value: number): void {
  if (Number.isFinite(value) && value >= 0) usage[key] = (usage[key] ?? 0) + value;
}
