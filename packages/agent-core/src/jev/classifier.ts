import type { Classifier, ClassifierAnswers } from '../classifier.js';
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
      const result = await client.evaluate(state, questions, signal === undefined ? {} : { signal });
      return { answers: classifierAnswers(result.answers) };
    },
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
