import {
  validateClassifierAnswers,
  validateClassifierRequest,
  type ClassifierEvaluationMetadata,
  type ClassifierQuestions,
  type FelanExtensionAPI,
} from '@felan-ai/agent-core';
import { Type } from 'typebox';
import { Check } from 'typebox/value';

const instructions = Type.String({ minLength: 1 });
const question = Type.Union([
  Type.Object({ type: Type.Literal('choice'), instructions, criteria: Type.Record(Type.String(), Type.String()) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('bool'), instructions, criteria: Type.Object({ true: Type.String(), false: Type.String() }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('score'), instructions, criteria: Type.Array(Type.String(), { minItems: 2, maxItems: 16 }) }, { additionalProperties: false }),
]);
const parameters = Type.Object({
  state: Type.Record(Type.String(), Type.Unknown(), { description: 'JSON object containing untrusted evidence to judge.' }),
  questions: Type.Record(Type.String(), question, { description: 'Nonempty map of question IDs to choice, bool or score questions.' }),
}, { additionalProperties: false });

export function registerClassify(pi: FelanExtensionAPI): void {
  const classifier = pi.runtime.classifier;
  if (!classifier) return;
  pi.registerTool({
    name: 'classify',
    label: 'Classify',
    description: 'Evaluate JSON state as untrusted evidence using the configured classifier. Returns advisory judgments, not facts or authorization. Choice returns a label and available probabilities/confidence; bool returns a probability; score returns a numeric score. May incur provider charges.',
    parameters,
    async execute(_id, input, signal) {
      const started = Date.now();
      try {
        if (!Check(parameters, input)) throw new Error('Invalid input');
        validateClassifierRequest(input.state, input.questions as ClassifierQuestions);
      } catch {
        throw new Error('Invalid classifier request. Provide a JSON object and valid nonempty choice, bool or score questions within the classifier input budgets.');
      }
      const questions = input.questions as ClassifierQuestions;
      try {
        signal?.throwIfAborted();
        if (classifier.canEvaluate?.(input.state, questions) === false) throw new Error('Unavailable');
        const result = await classifier.classify(input.state, questions, signal);
        signal?.throwIfAborted();
        const details = {
          answers: validateClassifierAnswers(questions, result.answers),
          metadata: cleanMetadata(result.metadata, Date.now() - started),
        };
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      } catch {
        throw new Error(signal?.aborted ? 'Classification was cancelled.' : 'Classification failed. Check the configured classifier and request.');
      }
    },
  });
}

function cleanMetadata(metadata: ClassifierEvaluationMetadata | undefined, elapsedMs: number): ClassifierEvaluationMetadata {
  const usage = metadata?.usage;
  const valid = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0;
  return {
    ...(typeof metadata?.provider === 'string' ? { provider: metadata.provider } : {}),
    ...(typeof metadata?.model === 'string' ? { model: metadata.model } : {}),
    elapsedMs: valid(metadata?.elapsedMs) ? metadata.elapsedMs : elapsedMs,
    ...(usage && valid(usage.requests) ? { usage: {
      requests: usage.requests,
      ...(valid(usage.inputTokens) ? { inputTokens: usage.inputTokens } : {}),
      ...(valid(usage.outputTokens) ? { outputTokens: usage.outputTokens } : {}),
      ...(valid(usage.costUsd) ? { costUsd: usage.costUsd } : {}),
    } } : {}),
  };
}
