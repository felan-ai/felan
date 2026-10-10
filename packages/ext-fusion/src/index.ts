import {
  associateExtensionConfig,
  type FelanExtension,
  type ExtensionCommandContext,
} from '@felan-ai/agent-core';
import type { Model } from '@felan-ai/agent-core';
import { FUSION_CONFIG } from './config.js';
import type { FusionHost, FusionModelChoice, FusionReview, FusionReviewActions } from './contracts.js';
import { FusionComparisonError, runFusion, compareFusionAnswers, synthesizeFusion } from './orchestration.js';
import { resolveFusionModels } from './models.js';
import { fusionReviewBytes, FUSION_STATE_ENTRY, latestFusionReview, validateFusionReview } from './session-state.js';
import { DEFAULT_FUSION_CONFIG } from './config.js';
import { FusionPanelError } from './contracts.js';

export function createFusionExtension(host?: FusionHost): FelanExtension {
  const extension: FelanExtension = (pi) => {
    let active: AbortController | undefined;
    let generation = 0;
    let selectedModels: { readonly participants: readonly string[]; readonly fusionModel: string } | undefined;

    const clearActive = (): void => {
      generation++;
      active?.abort();
      active = undefined;
    };
    pi.on('session_shutdown', clearActive);
    pi.on('session_before_switch', clearActive);
    pi.on('session_before_fork', clearActive);
    pi.on('session_before_tree', clearActive);

    pi.registerCommand('fusion', {
      description: 'Compare independent model answers, review their differences, then explicitly fuse them',
      handler: async (raw: string, ctx: ExtensionCommandContext) => {
        if (!host || ctx.mode !== 'tui' || !ctx.hasUI) {
          ctx.ui.notify('Fusion requires the local interactive review UI.', 'warning');
          return;
        }
        if (!ctx.isIdle()) {
          ctx.ui.notify('Wait for the current agent turn to finish before running /fusion.', 'warning');
          return;
        }
        if (active) {
          ctx.ui.notify('A Fusion run is already active.', 'warning');
          return;
        }
        const selectionGeneration = generation;
        let review = raw.trim() ? undefined : latestFusionReview(ctx.sessionManager.getBranch());
        if (review?.fused) review = undefined;
        const prompt = raw.trim() || review?.prompt || (await ctx.ui.input('New Fusion prompt'))?.trim();
        if (generation !== selectionGeneration || !prompt) return;
        if (review) {
          await openReview(ctx, () => review!, host, actionsFor(ctx, review, pi, configFrom(pi.config), () => active, (next) => { review = next; }, () => generation, (next) => { active = next; }));
          return;
        }

        const config = configFrom(pi.config);
        let participants = selectedModels?.participants ?? config.participants;
        let fusionModel = selectedModels?.fusionModel ?? config.fusionModel;
        const choices = availableModels(ctx);
        const allowedModels = new Set(choices.map(({ reference }) => reference));
        const invalidParticipants = participants.length < 2 || participants.length > 8
          || new Set(participants).size !== participants.length
          || participants.some((reference) => !allowedModels.has(reference));
        const invalidFusionModel = fusionModel === 'inherit'
          ? !ctx.model || !allowedModels.has(modelReference(ctx.model))
          : !allowedModels.has(fusionModel);
        if (invalidParticipants || invalidFusionModel) {
          const selected = await host.configure(ctx, choices, participants, fusionModel);
          if (generation !== selectionGeneration) return;
          if (!selected) return;
          participants = selected.participants;
          fusionModel = selected.fusionModel;
          selectedModels = selected;
        }
        if (host.selectRunAction) {
          while (true) {
            const action = await host.selectRunAction(ctx, participants, fusionModel);
            if (generation !== selectionGeneration || action === 'cancel') return;
            if (action === 'run') break;
            const selected = await host.configure(ctx, choices, participants, fusionModel);
            if (generation !== selectionGeneration || !selected) return;
            participants = selected.participants;
            fusionModel = selected.fusionModel;
            selectedModels = selected;
          }
        } else {
          const confirmed = await host.confirm(ctx, participants.length);
          if (generation !== selectionGeneration || !confirmed) return;
        }
        const runtime = resolveFusionModels(ctx, participants, fusionModel);
        const controller = new AbortController();
        const thisGeneration = ++generation;
        active = controller;
        ctx.ui.setStatus('fusion', `Fusion: asking ${runtime.participants.length} models…`);
        try {
          try {
            review = await runFusion({ prompt: prompt!, runtime, config, signal: controller.signal });
          } catch (error) {
            if (error instanceof FusionPanelError || error instanceof FusionComparisonError) review = error.review;
            else throw error;
          }
          if (!review || controller.signal.aborted || generation !== thisGeneration) return;
          persist(pi, review);
          await openReview(ctx, () => review!, host, actionsFor(ctx, review, pi, config, () => active, (next) => { review = next; persist(pi, next); }, () => generation, (next) => { active = next; }));
        } catch (error) {
          if (!controller.signal.aborted && generation === thisGeneration) ctx.ui.notify(safeError(error), 'error');
        } finally {
          if (active === controller) active = undefined;
          ctx.ui.setStatus('fusion', undefined);
        }
      },
    });
    pi.registerCommand('fusion-models', {
      description: 'Search and save the participant and comparison models used by /fusion',
      handler: async (_raw: string, ctx: ExtensionCommandContext) => {
        if (!host || ctx.mode !== 'tui' || !ctx.hasUI) {
          ctx.ui.notify('Fusion model configuration requires the local interactive review UI.', 'warning');
          return;
        }
        if (active) {
          ctx.ui.notify('Wait for the active Fusion stage to finish before changing its model lineup.', 'warning');
          return;
        }
        const thisGeneration = generation;
        const config = configFrom(pi.config);
        const selected = await host.configure(
          ctx,
          availableModels(ctx),
          selectedModels?.participants ?? config.participants,
          selectedModels?.fusionModel ?? config.fusionModel,
        );
        if (generation !== thisGeneration || !selected) return;
        selectedModels = selected;
        ctx.ui.notify(`Fusion lineup saved: ${selected.participants.length} participants; comparison model ${selected.fusionModel}.`, 'info');
      },
    });
  };
  associateExtensionConfig(extension, FUSION_CONFIG);
  return extension;
}

function actionsFor(
  ctx: ExtensionCommandContext,
  initial: FusionReview,
  pi: Parameters<FelanExtension>[0],
  config: ReturnType<typeof configFrom>,
  getActive: () => AbortController | undefined,
  setReview: (review: FusionReview) => void,
  getGeneration: () => number,
  setActive: (controller: AbortController | undefined) => void,
): FusionReviewActions {
  let review = initial;
  let busy = false;
  const sessionGeneration = getGeneration();
  const ensureController = (): AbortController => {
    if (getActive()) return getActive()!;
    const controller = new AbortController();
    setActive(controller);
    return controller;
  };
  const runStage = async (label: string, operation: (signal: AbortSignal) => Promise<FusionReview>): Promise<void> => {
    if (getGeneration() !== sessionGeneration) return;
    if (busy) {
      ctx.ui.notify('A Fusion stage is already running.', 'warning');
      return;
    }
    busy = true;
    const controller = ensureController();
    try {
      ctx.ui.setStatus('fusion', `Fusion: ${label}…`);
      const updated = await operation(controller.signal);
      if (controller.signal.aborted || sessionGeneration !== getGeneration()) return;
      review = updated;
      setReview(updated);
    } catch (error) {
      if (error instanceof FusionPanelError || error instanceof FusionComparisonError) {
        review = { ...review, ...error.review, answers: mergeAnswers(review.answers, error.review.answers) };
        setReview(review);
        ctx.ui.notify(error.message, 'warning');
      } else if (!controller.signal.aborted) ctx.ui.notify(safeError(error), 'error');
    } finally {
      busy = false;
      if (getActive() === controller) setActive(undefined);
      ctx.ui.setStatus('fusion', undefined);
    }
  };
  return {
    async retryParticipants() {
      const failed = review.failures?.map(({ model }) => model) ?? [];
      if (failed.length === 0) {
        ctx.ui.notify('There are no failed participant requests to retry.', 'info');
        return;
      }
      const runtime = resolveFusionModels(ctx, review.participants, review.fusionModel);
      await runStage('retrying failed models and comparing answers', async (signal) => {
        const next = await runFusion({
          prompt: review.prompt, runtime, config, signal,
          participantReferences: failed,
          existingAnswers: review.answers,
        });
        return next;
      });
    },
    async retryComparison() {
      const runtime = resolveFusionModels(ctx, review.participants, review.fusionModel);
      await runStage('comparing the original answers', async (signal) => ({
        ...review,
        comparison: await compareFusionAnswers(review.prompt, review.answers, runtime, config, signal),
        updatedAt: Date.now(),
      }));
    },
    async retryFusion() {
      if (!review.comparison) {
        ctx.ui.notify('Complete the comparison before fusing.', 'warning');
        return;
      }
      await this.fuse();
    },
    async fuse(instruction?: string, model?: string) {
      const runtime = resolveFusionModels(ctx, review.participants, review.fusionModel);
      await runStage('fusing selected answers', async (signal) => {
        const fused = await synthesizeFusion(review, runtime, config, signal, instruction, model);
        const updated = { ...review, fused, updatedAt: Date.now() };
        pi.sendMessage({ customType: FUSION_STATE_ENTRY, content: fused.text, display: true, details: { model: fused.model } }, { triggerTurn: false });
        return updated;
      });
    },
    cancel() {
      getActive()?.abort();
    },
  };
}

async function openReview(
  ctx: ExtensionCommandContext,
  getReview: () => FusionReview,
  host: FusionHost,
  actions: FusionReviewActions,
): Promise<void> {
  await host.review(ctx, getReview, actions);
}

function availableModels(ctx: ExtensionCommandContext): FusionModelChoice[] {
  const models = ctx.scopedModels.length === 0
    ? ctx.modelRegistry.getAvailable()
    : ctx.scopedModels.map(({ model }) => model).filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
  return models.map((model) => ({ reference: modelReference(model), label: `${model.name} (${modelReference(model)})` }));
}

function modelReference(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

function configFrom(config: Readonly<Record<string, unknown>>) {
  const participants = Array.isArray(config.participants) ? config.participants.filter((item): item is string => typeof item === 'string') : DEFAULT_FUSION_CONFIG.participants;
  const fusionModel = typeof config.fusionModel === 'string' ? config.fusionModel : DEFAULT_FUSION_CONFIG.fusionModel;
  const concurrency = numberOption(config.concurrency, DEFAULT_FUSION_CONFIG.concurrency, 1, 8);
  const timeoutSeconds = numberOption(config.timeoutSeconds, DEFAULT_FUSION_CONFIG.timeoutSeconds, 10, 600);
  const maxOutputChars = numberOption(config.maxOutputChars, DEFAULT_FUSION_CONFIG.maxOutputChars, 1000, 50000);
  const thinking = typeof config.thinking === 'string' && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(config.thinking)
    ? config.thinking as typeof DEFAULT_FUSION_CONFIG.thinking
    : DEFAULT_FUSION_CONFIG.thinking;
  return { participants, fusionModel, concurrency, timeoutSeconds, maxOutputChars, thinking };
}

function numberOption(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function persist(pi: Parameters<FelanExtension>[0], review: FusionReview): void {
  if (fusionReviewBytes(review) > 240_000 || !validateFusionReview(review)) {
    throw new Error('Fusion review is too large or invalid to save.');
  }
  pi.appendEntry(FUSION_STATE_ENTRY, review);
}

function mergeAnswers(current: FusionReview['answers'], incoming: FusionReview['answers']): FusionReview['answers'] {
  const byModel = new Map(current.map((answer) => [answer.model, answer]));
  for (const answer of incoming) byModel.set(answer.model, answer);
  return [...byModel.values()];
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Fusion failed.';
  return message.replace(/(?:Bearer\s+)[^\s,;]+/giu, 'Bearer [redacted]').slice(0, 400);
}

const fusionExtension = createFusionExtension();

export { FUSION_CONFIG, DEFAULT_FUSION_CONFIG, FUSION_THINKING_LEVELS } from './config.js';
export type { FusionConfig } from './config.js';
export type {
  FusionAnswer,
  FusionHost,
  FusionModelChoice,
  FusionModelRequest,
  FusionReview,
  FusionReviewActions,
  FusionStageResult,
} from './contracts.js';
export { FusionPanelError } from './contracts.js';
export { resolveFusionModels } from './models.js';
export type { FusionModelRuntime } from './models.js';
export { FusionComparisonError, compareFusionAnswers, runFusion, synthesizeFusion } from './orchestration.js';
export type { RunFusionOptions } from './orchestration.js';
export { buildComparisonPrompt, buildFusionPrompt } from './prompts.js';
export { FUSION_STATE_ENTRY, latestFusionReview, validateFusionReview } from './session-state.js';
export default fusionExtension;
