import {
  FusionPanelError,
  type FusionAnswer,
  type FusionFailure,
  type FusionModelRequest,
  type FusionReview,
  type FusionStageResult,
} from './contracts.js';
import type { FusionConfig } from './config.js';
import type { FusionModelRuntime } from './models.js';
import { buildComparisonPrompt, buildFusionPrompt } from './prompts.js';

export interface RunFusionOptions {
  readonly prompt: string;
  readonly runtime: FusionModelRuntime;
  readonly config: FusionConfig;
  readonly signal: AbortSignal;
  readonly onParticipantResult?: (result: FusionAnswer | FusionFailure) => void;
  readonly participantReferences?: readonly string[];
  readonly existingAnswers?: readonly FusionAnswer[];
}

const MAX_PROMPT_CHARS = 20_000;

export async function runFusion(options: RunFusionOptions): Promise<FusionReview> {
  const prompt = options.prompt.trim();
  if (!prompt) throw new Error('Enter a prompt for /fusion.');
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`Fusion prompt exceeds the ${MAX_PROMPT_CHARS}-character limit.`);
  if (options.signal.aborted) throw new Error('Fusion was cancelled.');
  if (options.runtime.participants.length < 2 || options.runtime.participants.length > 8) {
    throw new Error('Fusion requires between two and eight participant models.');
  }
  if (!options.runtime.fusionModel) throw new Error('Select an authenticated comparison and fusion model.');
  const targets = options.runtime.participants.filter((model) => (
    options.participantReferences === undefined || options.participantReferences.includes(model.reference)
  ));
  const answers: FusionAnswer[] = [...(options.existingAnswers ?? [])];
  const failures: FusionFailure[] = [];
  let nextIndex = 0;
  const workers = Math.min(options.config.concurrency, targets.length);
  await Promise.all(Array.from({ length: workers }, async () => {
    while (nextIndex < targets.length) {
      options.signal.throwIfAborted();
      const model = targets[nextIndex++]!;
      try {
        const result = await request(options, model, prompt);
        const answer = {
          ...result,
          model: model.reference,
          ...(result.model === model.reference ? {} : { actualModel: result.model }),
        };
        answers.push(answer);
        options.onParticipantResult?.(answer);
      } catch (error) {
        if (options.signal.aborted) throw cancelled();
        const failure = { model: model.reference, message: safeError(error) };
        failures.push(failure);
        options.onParticipantResult?.(failure);
      }
    }
  }));
  options.signal.throwIfAborted();
  if (answers.length < 2) {
    throw new FusionPanelError(
      `Fusion needs at least two successful model answers; received ${answers.length} of ${options.runtime.participants.length}.`,
      {
        prompt,
        participants: options.runtime.participants.map(({ reference }) => reference),
        fusionModel: options.runtime.fusionModel?.reference ?? '',
        answers,
        ...(failures.length === 0 ? {} : { failures }),
        updatedAt: Date.now(),
      },
    );
  }
  answers.sort((a, b) => options.runtime.participants.findIndex((model) => model.reference === a.model)
    - options.runtime.participants.findIndex((model) => model.reference === b.model));
  const review: FusionReview = {
    prompt,
    participants: options.runtime.participants.map(({ reference }) => reference),
    fusionModel: comparisonModelReference(options.runtime),
    answers,
    ...(failures.length === 0 ? {} : { failures }),
    updatedAt: Date.now(),
  };
  const comparisonModel = options.runtime.fusionModel;
  try {
    const comparison = await request(options, comparisonModel, buildComparisonPrompt(prompt, answers));
    return { ...review, comparison, updatedAt: Date.now() };
  } catch (error) {
    if (options.signal.aborted) throw cancelled();
    throw new FusionComparisonError(safeError(error), review);
  }
}

function comparisonModelReference(runtime: FusionModelRuntime): string {
  if (!runtime.fusionModel) throw new Error('Select an authenticated comparison and fusion model.');
  return runtime.fusionModel.reference;
}

export async function compareFusionAnswers(
  prompt: string,
  answers: readonly FusionAnswer[],
  runtime: FusionModelRuntime,
  config: FusionConfig,
  signal: AbortSignal,
): Promise<FusionStageResult> {
  if (answers.length < 2) throw new Error('Fusion comparison requires at least two successful model answers.');
  if (!runtime.fusionModel) throw new Error('Select an authenticated comparison and fusion model.');
  return request({ runtime, config, signal }, runtime.fusionModel, buildComparisonPrompt(prompt, answers));
}

export async function synthesizeFusion(
  review: FusionReview,
  runtime: FusionModelRuntime,
  config: FusionConfig,
  signal: AbortSignal,
  instruction?: string,
  modelOverride?: string,
): Promise<FusionStageResult> {
  if (!review.comparison) throw new Error('Complete the model comparison before fusing answers.');
  const model = modelOverride
    ? runtime.participants.find((candidate) => candidate.reference === modelOverride)
      ?? runtime.resolve(modelOverride)
    : runtime.fusionModel;
  if (!model) throw new Error('Select an available authenticated fusion model.');
  return request({ runtime, config, signal }, model, buildFusionPrompt(review, instruction));
}

async function request(
  options: Pick<RunFusionOptions, 'runtime' | 'config' | 'signal'>,
  model: FusionModelRuntime['participants'][number],
  prompt: string,
): Promise<FusionStageResult> {
  options.signal.throwIfAborted();
  const timeout = AbortSignal.timeout(options.config.timeoutSeconds * 1000);
  const signal = AbortSignal.any([options.signal, timeout]);
  const request: FusionModelRequest = {
    prompt,
    model,
    maxOutputChars: options.config.maxOutputChars,
    signal,
    thinking: options.config.thinking,
  };
  try {
    const result = await options.runtime.complete(request);
    if (signal.aborted) throw signal.reason;
    const text = result.text.trim();
    if (!text) throw new Error('Model returned no visible answer.');
    return {
      ...result,
      text: text.slice(0, options.config.maxOutputChars),
      ...(text.length > options.config.maxOutputChars ? { truncated: true } : {}),
    };
  } catch (error) {
    if (options.signal.aborted) throw cancelled();
    if (timeout.aborted) throw new Error(`Request timed out after ${options.config.timeoutSeconds} seconds.`);
    throw error;
  }
}

export class FusionComparisonError extends Error {
  readonly review: FusionReview;

  constructor(message: string, review: FusionReview) {
    super(`Fusion comparison failed: ${message}`);
    this.name = 'FusionComparisonError';
    this.review = review;
  }
}

function cancelled(): Error {
  return new Error('Fusion was cancelled.');
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'model request failed';
  return message
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/gu, '[redacted]')
    .replace(/\b(api[-_ ]?key|access[-_ ]?token|secret|authorization)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/https?:\/\/[^\s)]+/giu, '[provider URL]')
    .slice(0, 300);
}
