import type {
  Classifier,
  ClassifierAnswers,
  ClassifierProbabilityAnswers,
  ClassifierEvaluationMetadata,
} from '../classifier.js';
import {
  JevClientError,
  createJevClient,
  type CreateJevClientOptions,
  type JevAnswers,
} from './client.js';

export function createJevClassifier(): Classifier | undefined {
  return createJevClassifierWithOptions({});
}

export function createJevClassifierWithOptions(
  options: CreateJevClientOptions,
): Classifier | undefined {
  const client = createJevClient(options);
  if (!client.resolveTransport()) return undefined;
  return {
    async evaluate(state, questions, signal) {
      const started = Date.now();
      const result = await client.evaluate(state, questions, signal === undefined ? {} : { signal });
      return { answers: classifierAnswers(result.answers), metadata: evaluationMetadata(result, started) };
    },
    async evaluateProbabilities(state, questions, signal) {
      const started = Date.now();
      const result = await client.evaluate(
        state,
        Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, {
          type: 'noul' as const,
          instructions: question.instructions,
        }])),
        signal === undefined ? {} : { signal },
      );
      return {
        answers: classifierProbabilityAnswers(result.answers),
        metadata: evaluationMetadata(result, started),
      };
    },
  };
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
