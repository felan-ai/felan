import { configField, defineExtensionConfig } from '@felan-ai/agent-core';

export const FUSION_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export const FUSION_CONFIG = defineExtensionConfig({
  id: 'fusion',
  title: 'Fusion',
  fields: {
    participants: configField.json<readonly string[]>({
      default: [],
      label: 'Participant models',
      description: 'Distinct authenticated provider/model references; choose at least two before running /fusion.',
      validate(value) {
        if (!Array.isArray(value) || value.length > 8 || value.some((entry) => typeof entry !== 'string')) {
          return 'Participant models must be an array of at most eight provider/model references.';
        }
        if (new Set(value).size !== value.length) return 'Participant models must be unique.';
        return value.every(isModelReference) ? undefined : 'Each participant must use provider/model format.';
      },
    }),
    fusionModel: configField.string({
      default: 'inherit',
      label: 'Fusion model',
      description: 'Authenticated provider/model reference for comparisons and synthesis, or inherit the current model.',
      validate(value) {
        return value === 'inherit' || isModelReference(value)
          ? undefined
          : 'Fusion model must be inherit or use provider/model format.';
      },
    }),
    concurrency: configField.number({
      default: 4,
      label: 'Parallel requests',
      description: 'Maximum simultaneous participant requests (1–8).',
      validate: boundedInteger(1, 8),
    }),
    timeoutSeconds: configField.number({
      default: 120,
      label: 'Request timeout',
      description: 'Maximum seconds for each model request (10–600).',
      validate: boundedInteger(10, 600),
    }),
    maxOutputChars: configField.number({
      default: 12000,
      label: 'Answer size limit',
      description: 'Maximum visible characters retained per model answer (1000–50000).',
      validate: boundedInteger(1000, 50000),
    }),
    thinking: configField.enum(FUSION_THINKING_LEVELS, {
      default: 'off',
      label: 'Thinking level',
      description: 'Thinking level used for participant, comparison, and fusion requests.',
    }),
  },
});

export interface FusionConfig {
  readonly participants: readonly string[];
  readonly fusionModel: string;
  readonly concurrency: number;
  readonly timeoutSeconds: number;
  readonly maxOutputChars: number;
  readonly thinking: (typeof FUSION_THINKING_LEVELS)[number];
}

export const DEFAULT_FUSION_CONFIG: FusionConfig = {
  participants: [],
  fusionModel: 'inherit',
  concurrency: 4,
  timeoutSeconds: 120,
  maxOutputChars: 12000,
  thinking: 'off',
};

export function isModelReference(value: unknown): value is string {
  return typeof value === 'string' && /^[^/\s]+\/.+$/u.test(value.trim());
}

function boundedInteger(minimum: number, maximum: number) {
  return (value: unknown): string | undefined => (
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
      ? undefined
      : `Value must be an integer between ${minimum} and ${maximum}.`
  );
}
