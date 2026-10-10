import {
  Key,
  Input,
  matchesKey,
  truncateToWidth,
  Markdown,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import type { ExtensionCommandContext, Theme } from '@felan-ai/agent-core';
import type {
  FusionHost,
  FusionReview,
  FusionReviewActions,
  FusionStageResult,
} from '@felan-ai/ext-fusion';
import { setExtensionConfigValues } from '../settings.js';
import { FusionModelPicker, type FusionModelPickerOptions, type FusionModelPickerResult } from './model-picker.js';

export function createLocalFusionHost(agentDir: string): FusionHost {
  return {
    async selectRunAction(context, participants, fusionModel) {
      const model = fusionModel === 'inherit'
        ? `Current chat model (${context.model?.provider}/${context.model?.id})`
        : fusionModel;
      const choice = await context.ui.select(
        `Fusion lineup\n\nParticipants:\n${participants.map((reference) => `• ${cleanText(reference)}`).join('\n')}\n\nComparison / fusion: ${cleanText(model)}\n\n${participants.length} participant requests + 1 comparison request. Fuse adds another request. Provider billing may apply.`,
        ['Run with these models', 'Change models', 'Cancel'],
      );
      return choice === 'Run with these models' ? 'run' : choice === 'Change models' ? 'change' : 'cancel';
    },
    async confirm(context, participantCount) {
      return context.ui.confirm(
        'Run model comparison?',
        `This sends your prompt to ${participantCount} participant models and then makes one comparison request. Choosing Fuse later adds one more request. Provider billing may apply. Continue?`,
      );
    },
    async configure(context, models, configuredParticipants, configuredFusionModel) {
      if (models.length < 2) {
        context.ui.notify('Fusion needs at least two authenticated models in the current session model scope.', 'error');
        return undefined;
      }
      const selected = await openFusionModelPicker(context, {
        models,
        participants: configuredParticipants,
        fusionModel: configuredFusionModel,
      });
      if (!selected) return undefined;
      try {
        await setExtensionConfigValues(agentDir, 'fusion', {
          participants: selected.participants,
          fusionModel: selected.fusionModel,
        });
      } catch {
        context.ui.notify('Could not save Fusion model choices. No model requests were started.', 'error');
        return undefined;
      }
      return selected;
    },
    async review(context, getReview, actions) {
      let panel: FusionReviewPanel | undefined;
      await context.ui.custom<void>((tui, theme, _keybindings, done) => (
        panel = new FusionReviewPanel(context, getReview, actions, theme, () => tui.requestRender(), done, () => tui.terminal?.rows ?? 30)
      ), { overlay: true, overlayOptions: { anchor: 'top-left', width: '100%', maxHeight: '100%', margin: 0 } });
      await panel?.pendingFusion;
    },
  };
}

class FusionReviewPanel implements Component, Focusable {
  pendingFusion: Promise<void> | undefined;
  #page = 0;
  #scroll = 0;
  #busy = false;
  #closed = false;
  #focused = false;
  #instructionInput: Input | undefined;
  #modelPicker: FusionModelPicker | undefined;
  #viewportHeight = 12;
  #maximumScroll = 0;
  #selectedAction = 0;

  constructor(
    private readonly context: ExtensionCommandContext,
    private readonly getReview: () => FusionReview,
    private readonly actions: FusionReviewActions,
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly done: (result: void) => void,
    private readonly terminalRows: () => number,
  ) {}

  get focused(): boolean { return this.#focused; }
  set focused(value: boolean) {
    this.#focused = value;
    if (this.#instructionInput) this.#instructionInput.focused = value;
    if (this.#modelPicker) this.#modelPicker.focused = value;
  }

  handleInput(data: string): void {
    if (this.#closed) return;
    if (this.#modelPicker) {
      this.#modelPicker.handleInput(data);
      return;
    }
    if (this.#instructionInput) {
      if (matchesKey(data, Key.escape)) {
        this.#instructionInput = undefined;
      } else if (matchesKey(data, Key.enter)) {
        const instruction = this.#instructionInput.getValue();
        this.#instructionInput = undefined;
        this.chooseFusionModel(instruction);
      } else {
        this.#instructionInput.handleInput(data);
      }
      this.requestRender();
      return;
    }
    const wheel = /^\u001b\[<(64|65);\d+;\d+[Mm]$/u.exec(data);
    if (wheel) {
      this.scrollBy(wheel[1] === '64' ? -3 : 3);
      return;
    }
    if (!this.#busy && /^[1-6]$/u.test(data)) {
      const action = this.reviewOptions()[Number(data) - 1];
      if (action) this.handleInput(action.key);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (!this.#busy) this.handleInput(this.reviewOptions()[this.#selectedAction]?.key ?? 'q');
      return;
    }
    if (matchesKey(data, Key.escape) || data === 'q' || data === 'Q') {
      if (this.#busy) this.actions.cancel();
      this.close();
      return;
    }
    if (matchesKey(data, Key.left) || data === 'h') {
      this.#page = Math.max(0, this.#page - 1);
      this.#scroll = 0;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.right) || data === 'l' || matchesKey(data, Key.tab)) {
      this.#page = Math.min(this.pages().length - 1, this.#page + 1);
      this.#scroll = 0;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.#selectedAction = Math.max(0, this.#selectedAction - 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.#selectedAction = Math.min(this.reviewOptions().length - 1, this.#selectedAction + 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)
      || matchesKey(data, Key.home) || matchesKey(data, Key.end)) {
      if (matchesKey(data, Key.home)) this.#scroll = 0;
      else if (matchesKey(data, Key.end)) this.#scroll = this.#maximumScroll;
      else this.#scroll = Math.max(0, Math.min(this.#maximumScroll,
        this.#scroll + (matchesKey(data, Key.pageUp) ? -this.#viewportHeight : this.#viewportHeight)));
      this.requestRender();
      return;
    }
    if (this.#busy) return;
    if ((data === 'f' || data === 'F') && this.getReview().comparison) {
      if (data === 'f') this.fuseAndClose();
      else {
        this.#instructionInput = new Input({ placeholder: 'e.g. prioritize the simpler approach' });
        this.#instructionInput.focused = this.#focused;
        this.requestRender();
      }
    } else if (data === 'r' && this.getReview().failures?.length) {
      void this.run(() => this.actions.retryParticipants());
    } else if (data === 'c' && this.getReview().answers.length >= 2) {
      void this.run(() => this.actions.retryComparison());
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'wheel' || this.#instructionInput || this.#modelPicker) return undefined;
    this.scrollBy(Math.sign(event.wheelDelta ?? 0) * 3);
    return { handled: true };
  }

  private scrollBy(delta: number): void {
    this.#scroll = Math.max(0, Math.min(this.#maximumScroll, this.#scroll + delta));
    this.requestRender();
  }

  render(width: number): string[] {
    if (this.#modelPicker) return this.#modelPicker.render(width);
    if (this.#instructionInput) {
      return [
        this.theme.fg('accent', this.theme.bold('Fusion instruction (optional)')),
        this.theme.fg('dim', 'Enter choose model · Esc back to review'),
        ...this.#instructionInput.render(width),
      ].map((line) => truncateToWidth(line, width));
    }
    const contentWidth = Math.max(1, width);
    const review = this.getReview();
    const pages = this.pages();
    this.#page = Math.min(this.#page, pages.length - 1);
    const page = pages[this.#page]!;
    const status = review.fused ? 'Synthesis ready' : review.comparison ? 'Comparison ready — synthesis has not run' : 'Comparison unavailable — retry after reviewing source answers';
    const body = new Markdown(cleanText(page.text), 0, 0, getMarkdownTheme(), undefined, { preserveOrderedListMarkers: true }).render(contentWidth);
    const header = [
      this.theme.fg('accent', this.theme.bold('Fusion review')),
      this.theme.fg('dim', status),
      truncateToWidth(`Prompt: ${cleanText(review.prompt)}`, contentWidth),
      this.theme.fg('accent', `${cleanText(page.title)}  (${this.#page + 1}/${pages.length})`),
      this.theme.fg('dim', '─'.repeat(contentWidth)),
    ];
    const options = this.reviewOptions();
    this.#selectedAction = Math.min(this.#selectedAction, options.length - 1);
    const footer = this.#busy ? ['Working…  Esc cancels'] : [
      this.theme.fg('text', 'What would you like to do?'),
      ...options.map((option, index) => {
        const selected = index === this.#selectedAction;
        const label = `${index + 1}. ${option.label}`;
        return selected
          ? this.theme.fg('accent', `→ ${this.theme.bold(label)}`)
          : this.theme.fg('text', `  ${label}`);
      }),
      ...wrapTextWithAnsi(this.theme.fg('dim', '↑/↓ choose · Enter select · mouse wheel / PgUp/PgDn scroll · Home/End · ←/→ source pages · Esc close'), contentWidth),
    ];
    this.#viewportHeight = Math.max(1, this.terminalRows() - header.length - footer.length - 2);
    this.#maximumScroll = Math.max(0, body.length - this.#viewportHeight);
    this.#scroll = Math.min(this.#scroll, this.#maximumScroll);
    const visibleBody = body.slice(this.#scroll, this.#scroll + this.#viewportHeight);
    while (visibleBody.length < this.#viewportHeight) visibleBody.push('');
    return [
      ...header,
      ...visibleBody,
      this.theme.fg('dim', `Lines ${this.#scroll + 1}–${Math.min(body.length, this.#scroll + this.#viewportHeight)}/${body.length}`),
      this.theme.fg('dim', '─'.repeat(contentWidth)),
      ...footer,
    ].map((line) => truncateToWidth(line, contentWidth));
  }

  invalidate(): void {
    this.#instructionInput?.invalidate();
    this.#modelPicker?.invalidate();
  }

  private pages(): Array<{ title: string; text: string }> {
    const review = this.getReview();
    return [
      ...(review.comparison ? [{ title: 'Comparison', text: `${review.comparison.text}\n\n${formatUsage(review.comparison)}` }] : []),
      ...review.answers.map((answer) => ({
        title: `Answer · ${answer.model}${answer.actualModel ? ` → ${answer.actualModel}` : ''}`,
        text: `${answer.text}\n\n${formatUsage(answer)}`,
      })),
      ...(review.failures?.length ? [{
        title: `Unavailable participants (${review.failures.length})`,
        text: review.failures.map(({ model, message }) => `${model}: ${message}`).join('\n'),
      }] : []),
      ...(review.fused ? [{ title: `Fused answer · ${review.fused.model}`, text: `${review.fused.text}\n\n${formatUsage(review.fused)}` }] : []),
      ...(!review.answers.length && !review.comparison && !review.failures?.length ? [{ title: 'No model answers', text: 'No usable participant answer was saved. Close and run /fusion again.' }] : []),
    ];
  }

  private reviewOptions(): Array<{ label: string; key: string }> {
    const review = this.getReview();
    return [
      ...(review.comparison ? [{ label: 'Fuse', key: 'f' }, { label: 'Fuse with options', key: 'F' }] : []),
      ...(review.failures?.length ? [{ label: 'Retry failed models', key: 'r' }] : []),
      ...(review.answers.length >= 2 ? [{ label: 'Retry comparison', key: 'c' }] : []),
      { label: 'Cancel / close', key: 'q' },
    ];
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.#busy = true;
    this.requestRender();
    try {
      await action();
    } catch (error) {
      this.context.ui.notify(error instanceof Error ? error.message : 'Fusion action failed.', 'error');
    } finally {
      this.#busy = false;
      if (!this.#closed) this.requestRender();
    }
  }

  private fuseAndClose(instruction?: string, model?: string): void {
    this.pendingFusion = this.run(() => this.actions.fuse(instruction, model));
    this.close();
  }

  private chooseFusionModel(instruction: string): void {
    const choices = this.context.scopedModels.length === 0
      ? this.context.modelRegistry.getAvailable()
      : this.context.scopedModels.map(({ model }) => model).filter((model) => this.context.modelRegistry.hasConfiguredAuth(model));
    const models = choices.map((model) => ({
      reference: `${model.provider}/${model.id}`,
      label: cleanText(`${model.name} (${model.provider}/${model.id})`),
    }));
    this.#modelPicker = new FusionModelPicker({
      models,
      participants: this.getReview().participants,
      fusionModel: this.getReview().fusionModel,
      allowInherit: false,
      allowParticipants: false,
      initialMode: 'fusion',
      minParticipants: 0,
    }, this.theme, (selected) => {
      this.#modelPicker = undefined;
      if (selected) this.fuseAndClose(instruction, selected.fusionModel);
      else this.requestRender();
    }, this.requestRender);
    this.#modelPicker.focused = this.#focused;
  }

  private close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.done(undefined);
  }
}

async function openFusionModelPicker(
  context: ExtensionCommandContext,
  options: FusionModelPickerOptions,
): Promise<FusionModelPickerResult | undefined> {
  return context.ui.custom((tui, theme, _keybindings, done) => (
    new FusionModelPicker(options, theme, done, () => tui.requestRender())
  ));
}

function formatUsage(result: FusionStageResult): string {
  if (!result.usage) return `${result.durationMs} ms · usage unavailable`;
  return `${result.usage.input} input / ${result.usage.output} output tokens · estimated ${result.usage.estimatedCost.toFixed(4)} · ${result.durationMs} ms${result.truncated ? ' · truncated' : ''}`;
}

function cleanText(value: string): string {
  return value
    .replace(/\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ');
}
