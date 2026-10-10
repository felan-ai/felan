import {
  parseModelReference,
  type Api,
  type AssistantMessage,
  type ExtensionCommandContext,
  type Model,
} from '@felan-ai/agent-core';
import type { FusionModelChoice, FusionModelRequest, FusionStageResult } from './contracts.js';
import { isModelReference } from './config.js';

export interface FusionModelRuntime {
  readonly participants: readonly FusionModelChoice[];
  readonly fusionModel?: FusionModelChoice;
  resolve(reference: string): FusionModelChoice | undefined;
  complete(request: FusionModelRequest): Promise<FusionStageResult>;
}

export function resolveFusionModels(
  ctx: ExtensionCommandContext,
  participantReferences: readonly string[],
  fusionReference: string,
): FusionModelRuntime {
  if (ctx.signal?.aborted) throw new Error('Fusion was cancelled before model discovery.');
  const allowed = ctx.scopedModels.length === 0
    ? ctx.modelRegistry.getAvailable()
    : ctx.scopedModels.flatMap(({ model }) => {
        return ctx.modelRegistry.hasConfiguredAuth(model) ? [model] : [];
      });
  ctx.signal?.throwIfAborted();
  const models = new Map(allowed.map((model) => [formatReference(model), model]));
  const participants = participantReferences.map((reference) => {
    if (!isModelReference(reference)) throw new Error(`Invalid Fusion model reference: ${reference}`);
    const model = models.get(reference);
    if (!model) throw new Error(`Fusion model is unavailable, unauthenticated, or outside the session model scope: ${reference}`);
    return { reference, label: `${model.name} (${reference})` };
  });
  if (participants.length < 2 || participants.length > 8) {
    throw new Error('Configure between two and eight participant models before running /fusion.');
  }
  if (new Set(participantReferences).size !== participantReferences.length) {
    throw new Error('Fusion participant models must be unique.');
  }
  const fusionModel = fusionReference === 'inherit'
    ? ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model)
      ? { reference: formatReference(ctx.model), label: `${ctx.model.name} (${formatReference(ctx.model)})` }
      : undefined
    : resolveOne(fusionReference, models);
  if (!fusionModel) throw new Error('Select an authenticated fusion model before running /fusion.');

  return {
    participants,
    fusionModel,
    resolve(reference) {
      return resolveOne(reference, models);
    },
    async complete(request) {
      const model = models.get(request.model.reference);
      if (!model) throw new Error(`Fusion model is no longer available: ${request.model.reference}`);
      if (request.signal.aborted) throw new Error('Fusion request was cancelled.');
      const startedAt = Date.now();
      let message: AssistantMessage;
      try {
        message = await ctx.modelRegistry.streamSimple(model, {
          systemPrompt: 'Answer only the user\'s prompt. Do not use tools or claim to have executed actions.',
          messages: [{ role: 'user', content: request.prompt, timestamp: startedAt }],
        }, {
          signal: request.signal,
          maxTokens: outputTokenLimit(model, request.maxOutputChars),
          ...(request.thinking === 'off' ? {} : {
            reasoning: request.thinking as Exclude<NonNullable<Parameters<ExtensionCommandContext['modelRegistry']['streamSimple']>[2]>['reasoning'], undefined>,
          }),
        }).result();
      } catch (error) {
        if (request.signal.aborted) throw new Error('Fusion request was cancelled.');
        throw new Error(`Fusion request failed for ${request.model.reference}: ${safeError(error)}`);
      }
      const text = message.content
        .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
        .map(({ text: part }) => part)
        .join('\n')
        .trim();
      if (message.stopReason === 'error' || message.stopReason === 'aborted' || !text) {
        throw new Error(message.stopReason === 'aborted' ? 'Fusion request was cancelled.' : 'Fusion model returned no usable text.');
      }
      const truncated = text.length > request.maxOutputChars;
      return {
        text: truncated ? text.slice(0, request.maxOutputChars) : text,
        model: `${message.provider}/${message.model}`,
        durationMs: Date.now() - startedAt,
        ...(message.usage === undefined ? {} : {
          usage: {
            input: message.usage.input,
            output: message.usage.output,
            totalTokens: message.usage.totalTokens,
            estimatedCost: message.usage.cost.total,
          },
        }),
        ...(truncated ? { truncated: true } : {}),
      };
    },
  };
}

function resolveOne(reference: string, models: ReadonlyMap<string, Model<Api>>): FusionModelChoice {
  if (!parseModelReference(reference)) throw new Error(`Invalid Fusion model reference: ${reference}`);
  const model = models.get(reference);
  if (!model) throw new Error(`Fusion model is unavailable, unauthenticated, or outside the session model scope: ${reference}`);
  return { reference, label: `${model.name} (${reference})` };
}

function formatReference(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function outputTokenLimit(model: Model<Api>, maxOutputChars: number): number {
  const estimated = Math.max(256, Math.ceil(maxOutputChars / 3));
  return model.maxTokens > 0 ? Math.min(model.maxTokens, estimated) : estimated;
}

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : 'provider request failed';
  return text
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/gu, '[redacted]')
    .replace(/\b(api[-_ ]?key|access[-_ ]?token|secret|authorization)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/https?:\/\/[^\s)]+/giu, '[provider URL]')
    .slice(0, 300);
}
