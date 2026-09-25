import { isModelTier, type ClassifierQuestions, type FelanExtensionAPI, type ModelTier } from '@felan-ai/agent-core';
import type { SubagentDescriptor } from './contracts.js';

const TIER_QUESTION = 'model_tier';

const TIER_CRITERIA: Readonly<Record<ModelTier, string>> = {
  low: 'Mechanical lookup, file reading or summarising, or simple edits.',
  medium: 'Ordinary implementation or investigation.',
  high: 'Difficult debugging, cross-cutting or risky changes, or code review.',
  xhigh: 'Unusually complex architecture, design, planning, or high-stakes review.',
};

const TIER_QUESTIONS: ClassifierQuestions = {
  [TIER_QUESTION]: {
    type: 'choice',
    instructions: 'Given `subagent_type`, `agent_description`, `prompt`, and `description`, choose the model tier that matches the difficulty of the task the child agent must perform.',
    criteria: TIER_CRITERIA,
  },
};

export interface ModelTierClassificationInput {
  readonly prompt: string;
  readonly description: string;
  readonly subagent_type: string;
}

export async function classifySubagentModelTier(
  pi: FelanExtensionAPI,
  descriptor: SubagentDescriptor,
  input: ModelTierClassificationInput,
  signal: AbortSignal | undefined,
): Promise<ModelTier | undefined> {
  const classifier = pi.runtime?.classifier;
  const evaluate = classifier?.evaluate;
  if (classifier === undefined || typeof evaluate !== 'function') return undefined;
  const logger = pi.runtime?.logger?.child({ component: 'subagent-model' });
  if (signal?.aborted) return undefined;

  const state = {
    prompt: input.prompt,
    description: input.description,
    subagent_type: input.subagent_type,
    agent_description: descriptor.description,
  };

  try {
    const result = await evaluate.call(classifier, state, TIER_QUESTIONS, signal);
    if (signal?.aborted) return undefined;
    const choice = result.answers[TIER_QUESTION]?.choice;
    if (!isModelTier(choice)) {
      logger?.warn({
        event: 'decision',
        outcome: 'invalid_choice',
        type: input.subagent_type,
        choice,
      }, 'subagent model tier classification returned an invalid choice');
      return undefined;
    }
    logger?.debug({
      event: 'decision',
      outcome: 'classified',
      type: input.subagent_type,
      tier: choice,
      classifier: result.metadata,
    }, 'subagent model tier decision');
    return choice;
  } catch (error) {
    if (signal?.aborted) return undefined;
    logger?.warn({
      event: 'decision',
      outcome: 'failed',
      type: input.subagent_type,
      error: logError(error),
    }, 'subagent model tier classification failed');
    return undefined;
  }
}

function logError(value: unknown): { name: string; message: string; code?: string } {
  if (!(value instanceof Error)) return { name: 'Error', message: String(value) };
  const code = Reflect.get(value, 'code');
  return {
    name: value.name,
    message: value.message,
    ...(typeof code === 'string' ? { code } : {}),
  };
}
