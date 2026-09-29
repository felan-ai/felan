import type {
  Classifier,
  ClassifierAnswers,
  ClassifierProbabilityAnswers,
  ClassifierEvaluationMetadata,
} from '../types.js';
import {
  JevClientError,
  createJevClient,
  type CreateJevClientOptions,
  type JevAnswers,
} from './client.js';
import { createJevPreflight } from './preflight.js';
import type { Logger } from '../../logger.js';

const preflights = new WeakMap<Classifier, ReturnType<typeof createJevPreflight>>();
const jevClassifiers = new WeakSet<Classifier>();

export function attachJevPreflight(classifier: Classifier, logger: Logger) {
  if (!jevClassifiers.has(classifier)) return undefined;
  const preflight = createJevPreflight(logger);
  preflights.set(classifier, preflight);
  return preflight;
}

export function createJevClassifier(): Classifier | undefined {
  return createJevClassifierWithOptions({});
}

export function createJevClassifierWithOptions(
  options: CreateJevClientOptions,
): Classifier | undefined {
  const client = createJevClient(options);
  if (!client.resolveTransport()) return undefined;
  const classifier: Classifier = {
    canEvaluate(state, questions) {
      return client.canEvaluate(state, questions);
    },
    async evaluate(state, questions, signal) {
      const started = Date.now();
      const run = (activeSignal?: AbortSignal) => client.evaluate(
        state, questions, activeSignal === undefined ? {} : { signal: activeSignal },
      );
      const preflight = preflights.get(classifier);
      const result = preflight
        ? await preflight.evaluate(Object.keys(questions).join(','), run, signal)
        : await run(signal);
      return { answers: classifierAnswers(result.answers), metadata: evaluationMetadata(result, started) };
    },
    async evaluateProbabilities(state, questions, signal) {
      const started = Date.now();
      const run = (activeSignal?: AbortSignal) => client.evaluate(
        state,
        Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, {
          type: 'noul' as const,
          instructions: question.instructions,
        }])),
        activeSignal === undefined ? {} : { signal: activeSignal },
      );
      const preflight = preflights.get(classifier);
      const result = preflight
        ? await preflight.evaluate(Object.keys(questions).join(','), run, signal)
        : await run(signal);
      return {
        answers: classifierProbabilityAnswers(result.answers),
        metadata: evaluationMetadata(result, started),
      };
    },
  };
  jevClassifiers.add(classifier);
  return classifier;
}

function evaluationMetadata(
  result: { readonly provider: string; readonly model: string; readonly usage?: {
    readonly requests: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly costUsd?: number;
  } },
  started: number,
): ClassifierEvaluationMetadata {
  return {
    provider: result.provider,
    model: result.model,
    elapsedMs: Date.now() - started,
    ...(result.usage === undefined ? {} : { usage: { ...result.usage } }),
  };
}

function classifierAnswers(answers: JevAnswers): ClassifierAnswers {
  const choices: Record<string, ClassifierAnswers[string]> = {};
  for (const [name, answer] of Object.entries(answers)) {
    if (answer.type !== 'choice') {
      throw new JevClientError('response_invalid', `Jev returned a non-choice answer for ${name}`);
    }
    choices[name] = answer;
  }
  return choices;
}

function classifierProbabilityAnswers(answers: JevAnswers): ClassifierProbabilityAnswers {
  const probabilities: Record<string, ClassifierProbabilityAnswers[string]> = {};
  for (const [name, answer] of Object.entries(answers)) {
    if (answer.type !== 'noul') {
      throw new JevClientError('response_invalid', `Jev returned a non-noul answer for ${name}`);
    }
    probabilities[name] = { probability: answer.noul };
  }
  return probabilities;
}
