import {
  type ExtensionCommandContext, type FelanExtensionAPI, type ModelsService, type SessionEntry,
  type UiAction, type UiForm, type UiValues,
} from '@felan-ai/agent-core';
import { parseUiForm, validateUiFormAnswer } from '@felan-ai/session-protocol';
import { resolveFusionConfig, type FusionConfig } from './config.js';
import { FusionPanelError, type FusionReview } from './contracts.js';
import { FUSION_PICKER_HINT, FUSION_REVIEW_HINT, FusionSurface, fusionMarkdown, fusionReviewPages } from './generic-ui.js';
import { fusionModelCatalogue, fusionModelChoice, resolveServiceFusionModels } from './service-models.js';
import { compareFusionAnswers, FusionComparisonError, runFusion, synthesizeFusion } from './orchestration.js';
import { FUSION_STATE_ENTRY, latestFusionReview, validateFusionReview } from './session-state.js';

const LINEUP_ENTRY = 'felan.fusion-lineup.v1';
interface Lineup { participants: readonly string[]; fusionModel: string }
const action = (id: string, label: string, outcome: 'submit' | 'cancel' = 'submit'): UiAction => ({ id, label, target: 'element', outcome });

export function registerGenericFusion(pi: FelanExtensionAPI, models: ModelsService | undefined): void {
  const app = new FusionApplication(pi, models);
  pi.registerCommand('fusion', { description: 'Compare model answers and explicitly request synthesis', handler: (args, ctx) => app.command(args, ctx, false) });
  pi.registerCommand('fusion-models', { description: 'Choose and save the Fusion model lineup', handler: (_args, ctx) => app.command('', ctx, true) });
  const stopActive = () => app.stop(false);
  pi.on('session_before_switch', stopActive);
  pi.on('session_before_fork', stopActive);
  pi.on('session_before_tree', stopActive);
  pi.on('session_shutdown', () => app.stop(true));
}

class FusionApplication {
  private lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly modelCalls = new Set<Promise<unknown>>();
  private readonly surfaces = new Set<FusionSurface>();
  private active: AbortController | undefined;
  private open = false;
  private stopping = false;
  private stopped = false;
  private cleanup: Promise<void> | undefined;
  private review: FusionReview | undefined;
  private document: FusionSurface | undefined;
  private page = 0;
  private lastSynthesis: { instruction?: string; model?: string } | undefined;

  constructor(private readonly pi: FelanExtensionAPI, private readonly models: ModelsService | undefined) {}

  private track = <T>(work: Promise<T>, set = this.pending): Promise<T> => {
    set.add(work); void work.then(() => set.delete(work), () => set.delete(work)); return work;
  };
  private trackModel = <T>(work: Promise<T>): Promise<T> => this.track(work, this.modelCalls);

  command(raw: string, ctx: ExtensionCommandContext, modelsOnly: boolean): Promise<void> {
    return this.track(this.runCommand(raw, ctx, modelsOnly));
  }

  private async runCommand(raw: string, ctx: ExtensionCommandContext, modelsOnly: boolean): Promise<void> {
    if (this.stopped || this.stopping) throw new Error('Fusion is shutting down.');
    if (!this.models) { await this.pi.ui.notify({ level: 'warning', text: 'Fusion requires a configured Models service.' }); return; }
    if (this.open || !ctx.isIdle()) { await this.pi.ui.notify({ level: 'warning', text: 'Finish the active command or agent turn before opening Fusion.' }); return; }
    this.open = true;
    const signal = AbortSignal.any([this.lifetime.signal, ...(ctx.signal ? [ctx.signal] : [])]);
    const config = resolveFusionConfig(this.pi.config);
    try {
      let lineup = latestLineup(ctx.sessionManager.getBranch()) ?? { participants: config.participants, fusionModel: config.fusionModel };
      if (modelsOnly) { await this.chooseModels(lineup, ctx, signal); return; }
      this.review = raw.trim() ? undefined : latestFusionReview(ctx.sessionManager.getBranch());
      if (this.review?.fused) this.review = undefined;
      this.lastSynthesis = undefined;
      if (!this.review) {
        let prompt = raw.trim();
        if (!prompt) {
          const answer = await this.form({ title: 'New Fusion prompt', fallback: 'Enter the same prompt for all participant models.',
            input: { fields: [{ id: 'prompt', kind: 'string', label: 'Prompt', required: true, multiline: true, maxLength: 32 * 1024 }] },
            actions: [action('continue', 'Continue'), action('cancel', 'Cancel', 'cancel')] }, signal);
          if (!answer) return;
          prompt = (answer.values.prompt as string).trim();
        }
        if (!prompt || prompt.length > 20_000) throw new Error('Fusion requires a nonempty prompt of at most 20000 characters.');
        for (;;) {
          const catalogue = await this.trackModel(fusionModelCatalogue(this.models, signal));
          const references = new Set(catalogue.map(model => fusionModelChoice(model).reference));
          const comparison = lineup.fusionModel === 'inherit' && ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : lineup.fusionModel;
          if (lineup.participants.length < 2 || lineup.participants.length > 8 || new Set(lineup.participants).size !== lineup.participants.length
            || lineup.participants.some(reference => !references.has(reference)) || !references.has(comparison)) {
            const selected = await this.chooseModels(lineup, ctx, signal);
            if (!selected) return;
            lineup = selected;
          } else lineup = { ...lineup, fusionModel: comparison };
          const answer = await this.form({ title: 'Compare independent answers?',
            markdown: fusionMarkdown(`Participants: ${lineup.participants.join(', ')}\nComparison model: ${lineup.fusionModel}\nThis makes ${lineup.participants.length + 1} model requests. Provider charges may apply. Comparison does not synthesize or run tools.`),
            fallback: 'Explicitly approve the participant requests and comparison, change models, or cancel.', input: { fields: [] },
            actions: [action('compare', 'Run participants and compare'), action('change', 'Change models'), action('cancel', 'Cancel', 'cancel')] }, signal);
          if (!answer) return;
          if (answer.actionId === 'compare') break;
          const selected = await this.chooseModels(lineup, ctx, signal);
          if (!selected) return;
          lineup = selected;
        }
        await this.stage('Asking participants and comparing answers', signal, async stageSignal => {
          const runtime = await resolveServiceFusionModels(this.models!, lineup.participants, lineup.fusionModel, stageSignal, this.trackModel);
          return runFusion({ prompt, runtime, config, signal: stageSignal });
        });
      }
      if (this.review && !signal.aborted) await this.showReview(config, signal);
    } catch (error) {
      if (!signal.aborted) await this.pi.ui.notify({ level: 'error', text: safeFailure(error) });
    } finally { this.open = false; }
  }

  private async form(form: UiForm, signal: AbortSignal) {
    signal.throwIfAborted(); parseUiForm(form);
    const result = await this.pi.ui.request(form, { signal });
    signal.throwIfAborted();
    if (result.state === 'deferred') {
      await this.pi.ui.notify({ level: 'info', text: `Fusion is waiting for interaction ${result.interactionId}; no model requests were started.` });
      return undefined;
    }
    if (result.state !== 'answered') return undefined;
    const answer = validateUiFormAnswer(form, result.answer);
    return answer.outcome === 'cancel' ? undefined : answer;
  }

  private surface(handler: ConstructorParameters<typeof FusionSurface>[2]): FusionSurface {
    const surface = new FusionSurface(this.pi.ui, this.lifetime.signal, (request, context) => this.track(handler(request, context)));
    this.surfaces.add(surface); return surface;
  }

  private async close(surface: FusionSurface): Promise<void> {
    await surface.close(); this.surfaces.delete(surface);
  }

  private async chooseModels(initial: Lineup, ctx: ExtensionCommandContext, signal: AbortSignal): Promise<Lineup | undefined> {
    const catalogue = await this.trackModel(fusionModelCatalogue(this.models!, signal));
    if (catalogue.length < 2) throw new Error('Fusion requires at least two available authenticated text models.');
    const available = catalogue.map(fusionModelChoice);
    const known = new Set(available.map(choice => choice.reference));
    const participants = new Set(initial.participants);
    let comparison = initial.fusionModel === 'inherit' && ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : initial.fusionModel;
    const unavailable = [...new Set([...participants, comparison])].filter(reference => reference && !known.has(reference));
    const choices = [...unavailable.map(reference => ({ reference, label: `Unavailable: ${reference}` })), ...available];
    let query = ''; let page = 0;
    let finish!: (value: Lineup | undefined) => void;
    const done = new Promise<Lineup | undefined>(resolve => { finish = resolve; });
    const abort = () => finish(undefined);
    signal.addEventListener('abort', abort, { once: true });
    const surface = this.surface(async (request, context) => {
      signal.throwIfAborted(); context.signal.throwIfAborted();
      if (request.actionId === 'cancel') { finish(undefined); return; }
      if (request.actionId === 'save') {
        if (participants.size < 2 || participants.size > 8 || [...participants].some(reference => !known.has(reference)) || !known.has(comparison)) {
          throw new Error('Select two to eight available participants and one comparison model before saving.');
        }
        const selected = { participants: [...participants], fusionModel: comparison };
        this.pi.appendEntry(LINEUP_ENTRY, selected);
        try { await this.pi.updateConfig(selected); }
        catch (error) {
          if (signal.aborted || context.signal.aborted) throw error;
          const message = `Fusion lineup is saved for this session, but global settings persistence failed: ${safeFailure(error)}`;
          await this.pi.ui.notify({ level: 'error', text: message });
          throw new Error(message);
        }
        signal.throwIfAborted(); context.signal.throwIfAborted();
        finish(selected); return;
      }
      if (request.actionId === 'search') { query = request.values.query as string; page = 0; }
      else if (request.actionId === 'next') page++;
      else if (request.actionId === 'previous') page--;
      else if (request.actionId === 'clear') { participants.clear(); comparison = ''; }
      else {
        const choice = choices[Number(request.itemId!.slice(6))];
        if (!choice) throw new Error('Unknown Fusion model choice.');
        if (request.actionId === 'comparison') {
          if (!known.has(choice.reference)) throw new Error('Choose an available comparison / fusion model.');
          comparison = choice.reference;
        }
        else if (participants.has(choice.reference)) participants.delete(choice.reference);
        else {
          if (!known.has(choice.reference)) throw new Error('Remove or replace unavailable participants.');
          if (participants.size >= 8) throw new Error('Fusion supports at most eight participants.');
          participants.add(choice.reference);
        }
      }
      await render();
    });
    const render = () => surface.publish((id, revision) => {
      const filtered = choices.map((choice, index) => ({ choice, index })).filter(({ choice }) => `${choice.reference} ${choice.label}`.toLowerCase().includes(query.toLowerCase()));
      const pages = Math.max(1, Math.ceil(filtered.length / 40)); page = Math.max(0, Math.min(page, pages - 1));
      const unavailableParticipants = [...participants].some(reference => !known.has(reference));
      const unavailableComparison = comparison && !known.has(comparison);
      return { id, revision, kind: 'view', hint: FUSION_PICKER_HINT, title: 'Fusion model lineup',
        fallback: [
          ...(unavailableParticipants || unavailableComparison ? ['Unavailable saved model choices must be replaced before saving.'] : []),
          ...(unavailableParticipants ? ['Remove or replace unavailable participants.'] : []),
          ...(unavailableComparison ? ['Choose an available comparison / fusion model.'] : []),
          `Participants: ${[...participants].join(', ') || 'none'}`,
          `Comparison: ${comparison || 'none'}`,
          `Page ${page + 1}/${pages}. Select two to eight participants and a comparison model, then save explicitly.`,
        ].join('\n'),
        fields: [{ id: 'model', label: 'Model', valueKind: 'text' }, { id: 'participant', label: 'Participant', valueKind: 'boolean' }, { id: 'comparison', label: 'Comparison', valueKind: 'boolean' }],
        items: filtered.slice(page * 40, page * 40 + 40).map(({ choice, index }) => ({ id: `model-${index}`, values: {
          model: choice.label, participant: participants.has(choice.reference), comparison: choice.reference === comparison,
        }, fallback: choice.reference })),
        query: { actionId: 'search', values: { query } },
        actions: [{ ...action('search', 'Search models'), input: { fields: [{ id: 'query', kind: 'string', label: 'Name or provider/model', required: true, maxLength: 4096 }] } },
          { id: 'participant', label: 'Toggle participant', target: 'item', outcome: 'submit' }, { id: 'comparison', label: 'Use for comparison', target: 'item', outcome: 'submit' },
          ...(page > 0 ? [action('previous', 'Previous models')] : []), ...(page + 1 < pages ? [action('next', 'Next models')] : []),
          action('clear', 'Clear lineup'), action('save', 'Save lineup'), action('cancel', 'Cancel', 'cancel')],
        ...(pages > 1 ? { paging: { ...(page > 0 ? { previousActionId: 'previous' } : {}), ...(page + 1 < pages ? { nextActionId: 'next' } : {}) } } : {}),
      };
    });
    try { signal.throwIfAborted(); await render(); return await done; }
    finally { signal.removeEventListener('abort', abort); await this.close(surface); }
  }

  private async stage(label: string, parentSignal: AbortSignal, operation: (signal: AbortSignal) => Promise<FusionReview>, onSuccess?: () => void): Promise<void> {
    if (this.active) throw new Error('A Fusion stage is already active.');
    const control = new AbortController(); this.active = control;
    const signal = AbortSignal.any([parentSignal, this.lifetime.signal, control.signal]);
    const progress = this.surface(async () => { control.abort(); });
    try {
      await progress.publish((id, revision) => ({ id, revision, kind: 'progress', label, state: 'running',
        fallback: `${label}. Cancellation is best effort; provider charges may still apply.`, actions: [action('cancel', 'Cancel requests', 'cancel')] }));
      if (this.document) await this.renderReview();
      signal.throwIfAborted();
      const next = await operation(signal);
      signal.throwIfAborted(); this.review = next; this.persist(); onSuccess?.();
    } catch (error) {
      if (!signal.aborted) {
        if (error instanceof FusionPanelError || error instanceof FusionComparisonError) { this.review = error.review; this.persist(); }
        await this.pi.ui.notify({ level: 'error', text: safeFailure(error) });
      }
    } finally {
      while (this.modelCalls.size) await Promise.allSettled([...this.modelCalls]);
      try { await this.close(progress); } finally { this.active = undefined; }
      if (this.document && !this.lifetime.signal.aborted) await this.renderReview();
    }
  }

  private persist(): void {
    if (!this.review || !validateFusionReview(this.review)) throw new Error('Fusion review exceeds the saved review limits or is invalid. It was not truncated.');
    this.pi.appendEntry(FUSION_STATE_ENTRY, this.review);
  }

  private async showReview(config: FusionConfig, signal: AbortSignal): Promise<void> {
    this.page = 0;
    let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
    signal.addEventListener('abort', finish, { once: true });
    const document = this.surface(async (request, context) => {
      const actionSignal = AbortSignal.any([signal, context.signal]);
      actionSignal.throwIfAborted();
      if (request.actionId === 'close') { finish(); return; }
      if (request.actionId === 'next' || request.actionId === 'previous') {
        this.page += request.actionId === 'next' ? 1 : -1; await this.renderReview(); return;
      }
      const review = this.review!;
      const runtime = (stageSignal: AbortSignal) => resolveServiceFusionModels(this.models!, review.participants, review.fusionModel, stageSignal, this.trackModel);
      if (request.actionId === 'retry-participants' || request.actionId === 'retry-comparison') {
        const { comparison: _comparison, fused: _fused, ...withoutComparison } = review;
        this.review = withoutComparison; this.persist();
        await this.stage('Retrying and comparing answers', actionSignal, async stageSignal => {
          const models = await runtime(stageSignal);
          if (request.actionId === 'retry-participants') return runFusion({ prompt: review.prompt, runtime: models, config, signal: stageSignal,
            participantReferences: review.failures?.map(failure => failure.model) ?? [], existingAnswers: review.answers });
          return { ...withoutComparison, comparison: await compareFusionAnswers(review.prompt, review.answers, models, config, stageSignal), updatedAt: Date.now() };
        });
      } else {
        const input = request.actionId === 'retry-synthesis' ? this.lastSynthesis! : synthesisInput(request.values);
        this.lastSynthesis = input;
        await this.stage('Synthesizing reviewed answers', actionSignal, async stageSignal => ({ ...review,
          fused: await synthesizeFusion(review, await runtime(stageSignal), config, stageSignal, input.instruction, input.model), updatedAt: Date.now(),
        }), () => this.pi.sendMessage({ customType: FUSION_STATE_ENTRY, content: this.review!.fused!.text, display: true,
          details: { model: this.review!.fused!.model } }, { triggerTurn: false }));
      }
    });
    this.document = document;
    try { signal.throwIfAborted(); await this.renderReview(); await done; }
    finally { signal.removeEventListener('abort', finish); this.document = undefined; await this.close(document); }
  }

  private renderReview(): Promise<void> {
    const review = this.review!; const pages = fusionReviewPages(review);
    this.page = Math.max(0, Math.min(this.page, pages.length - 1));
    return this.document!.publish((id, revision) => ({ id, revision, kind: 'document', hint: FUSION_REVIEW_HINT, title: `Fusion review (${this.page + 1}/${pages.length})`,
      markdown: pages[this.page]!, fallback: 'Review the original answers and comparison. Synthesis requires an explicit action and may incur charges.',
      actions: this.active ? [] : [
        ...(this.page ? [action('previous', 'Previous page')] : []), ...(this.page + 1 < pages.length ? [action('next', 'Next page')] : []),
        ...(review.failures?.length ? [action('retry-participants', 'Retry failed participants and compare')] : []),
        ...(review.answers.length >= 2 ? [action('retry-comparison', 'Retry comparison')] : []),
        ...(review.comparison ? [{ ...action('synthesize', 'Synthesize reviewed answers'), input: { fields: [
          { id: 'instruction', kind: 'string' as const, label: 'Optional synthesis instruction', required: false, multiline: true, maxLength: 16_000 },
          { id: 'model', kind: 'string' as const, label: 'Optional available provider/model override', required: false, maxLength: 300 },
        ] } }, ...(this.lastSynthesis ? [action('retry-synthesis', 'Retry synthesis')] : [])] : []),
        action('close', 'Close review', 'cancel'),
      ],
    }));
  }

  stop(permanent: boolean): Promise<void> {
    this.stopped ||= permanent;
    if (this.cleanup) return this.cleanup;
    this.stopping = true;
    this.cleanup = (async () => {
      try {
        this.lifetime.abort(); this.active?.abort();
        const closing = Promise.allSettled([...this.surfaces].map(surface => surface.close()));
        while (this.pending.size || this.modelCalls.size) await Promise.allSettled([...this.pending, ...this.modelCalls]);
        const results = [...await closing, ...await Promise.allSettled([...this.surfaces].map(surface => surface.settle()))];
        this.surfaces.clear(); this.review = undefined; this.document = undefined; this.active = undefined;
        const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (failures.length) throw new AggregateError(failures, 'Fusion UI cleanup failed.');
      } finally {
        this.stopping = false;
        if (!this.stopped) { this.lifetime = new AbortController(); this.cleanup = undefined; }
      }
    })();
    return this.cleanup;
  }
}

function synthesisInput(values: UiValues): { instruction?: string; model?: string } {
  const instruction = (values.instruction as string | undefined)?.trim();
  const model = (values.model as string | undefined)?.trim();
  return { ...(instruction ? { instruction } : {}), ...(model ? { model } : {}) };
}

function latestLineup(entries: readonly SessionEntry[]): Lineup | undefined {
  for (const entry of [...entries].reverse()) {
    if (entry.type !== 'custom' || entry.customType !== LINEUP_ENTRY) continue;
    const value = entry.data as Partial<Lineup> | null;
    if (value && Array.isArray(value.participants) && value.participants.length >= 2 && value.participants.length <= 8
      && new Set(value.participants).size === value.participants.length && value.participants.every(reference => typeof reference === 'string' && reference.length <= 300)
      && typeof value.fusionModel === 'string' && value.fusionModel.length <= 300) return { participants: [...value.participants], fusionModel: value.fusionModel };
    return undefined;
  }
  return undefined;
}

function safeFailure(error: unknown): string {
  return (error instanceof Error ? error.message : 'Fusion failed.')
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/gu, '[redacted]')
    .replace(/\b(api[-_ ]?key|access[-_ ]?token|secret|authorization)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/https?:\/\/[^\s)]+/giu, '[provider URL]').slice(0, 400);
}
