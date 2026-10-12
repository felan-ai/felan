import {
  Key, Input, matchesKey, truncateToWidth, Markdown, wrapTextWithAnsi,
  type Component, type Focusable, type MarkdownTheme, type TuiMouseEvent, type TuiMouseEventResult,
} from '@earendil-works/pi-tui';
import type { ExtensionCommandContext, Theme } from '@felan-ai/agent-core';
import type { FusionModelChoice, FusionReview, FusionReviewActions, FusionStageResult } from './contracts.js';
import { FusionModelPicker, type FusionModelPickerOptions, type FusionModelPickerResult } from './model-picker.js';
import type { FusionReviewDecision } from './presentation.js';
export { FusionModelPicker } from './model-picker.js';
export type { FusionModelPickerOptions, FusionModelPickerResult } from './model-picker.js';
export type { FusionModelChoice, FusionReview, FusionReviewActions } from './contracts.js';
export * from './presentation.js';

type FusionUi = Pick<ExtensionCommandContext['ui'], 'custom' | 'notify'>;

export async function presentFusionModelPicker(
  ui: Pick<FusionUi, 'custom'>,
  options: FusionModelPickerOptions,
  signal?: AbortSignal,
): Promise<FusionModelPickerResult | undefined> {
  if (signal?.aborted) return undefined;
  let removeAbort: (() => void) | undefined;
  try {
    return await ui.custom<FusionModelPickerResult | undefined>((tui, theme, _keybindings, done) => {
      let settled = false;
      const finish = (value: FusionModelPickerResult | undefined) => {
        if (settled) return;
        settled = true; picker.dispose(); done(value);
      };
      const picker = new FusionModelPicker(options, theme, finish, () => tui.requestRender());
      const abort = () => finish(undefined);
      if (signal?.aborted) queueMicrotask(abort);
      else if (signal) { signal.addEventListener('abort', abort, { once: true }); removeAbort = () => signal.removeEventListener('abort', abort); }
      return picker;
    });
  } finally { removeAbort?.(); }
}

export async function presentFusionDecision(
  ui: FusionUi,
  review: FusionReview,
  busy: boolean,
  signal: AbortSignal,
  validate?: (decision: FusionReviewDecision) => string | undefined,
): Promise<FusionReviewDecision | undefined> {
  if (signal.aborted) return undefined;
  let removeAbort: (() => void) | undefined;
  try {
    return await ui.custom<FusionReviewDecision | undefined>((tui, theme, _keybindings, done) => {
      let settled = false;
      const finish = (decision: FusionReviewDecision | undefined): string | undefined => {
        if (settled) return undefined;
        const error = decision && validate?.(decision);
        if (error) { ui.notify(error, 'warning'); return error; }
        settled = true; panel.dispose(); done(decision); return undefined;
      };
      const actions: FusionReviewActions = {
        fuse: async () => { finish({ action: 'fuse' }); },
        retryParticipants: async () => { finish({ action: 'retry_participants' }); },
        retryComparison: async () => { finish({ action: 'retry_comparison' }); },
        retryFusion: async () => { finish({ action: 'fuse' }); },
        cancel: () => { finish({ action: 'close' }); },
      };
      const panel = new FusionReviewPanel({ getModels: () => [], notify: (...args) => ui.notify(...args),
        chooseModel: instruction => finish({ action: 'choose_model', instruction }) },
      () => review, actions, theme, () => tui.requestRender(), () => { finish({ action: 'close' }); }, () => tui.terminal?.rows ?? 30, busy);
      const abort = () => { finish(undefined); };
      if (signal.aborted) queueMicrotask(abort);
      else { signal.addEventListener('abort', abort, { once: true }); removeAbort = () => signal.removeEventListener('abort', abort); }
      return panel;
    }, { overlay: true, overlayOptions: { anchor: 'top-left', width: '100%', maxHeight: '100%', margin: 0 } });
  } finally { removeAbort?.(); }
}

export async function presentFusionReview(
  ui: FusionUi,
  getModels: () => readonly FusionModelChoice[],
  getReview: () => FusionReview,
  actions: FusionReviewActions,
): Promise<void> {
  let panel: FusionReviewPanel | undefined;
  try {
    await ui.custom<void>((tui, theme, _keybindings, done) => (
      panel = new FusionReviewPanel({ getModels, notify: (...args) => ui.notify(...args) }, getReview, actions,
        theme, () => tui.requestRender(), done, () => tui.terminal?.rows ?? 30)
    ), { overlay: true, overlayOptions: { anchor: 'top-left', width: '100%', maxHeight: '100%', margin: 0 } });
  } catch (error) {
    if (panel?.pendingAction) {
      actions.cancel();
      await panel.pendingAction;
    }
    throw error;
  }
  await panel?.pendingAction;
}

export class FusionReviewPanel implements Component, Focusable {
  pendingAction: Promise<void> | undefined;
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
  #validationError: string | undefined;

  constructor(
    private readonly context: { readonly getModels: () => readonly FusionModelChoice[]; readonly notify: FusionUi['notify']; readonly chooseModel?: (instruction: string) => string | undefined },
    private readonly getReview: () => FusionReview,
    private readonly actions: FusionReviewActions,
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly done: (result: void) => void,
    private readonly terminalRows: () => number,
    busy = false,
  ) { this.#busy = busy; }

  dispose(): void { this.#closed = true; }

  get focused(): boolean { return this.#focused; }
  set focused(value: boolean) {
    this.#focused = value;
    if (this.#instructionInput) this.#instructionInput.focused = value;
    if (this.#modelPicker) this.#modelPicker.focused = value;
  }

  handleInput(data: string): void {
    if (this.#closed) return;
    this.#validationError = undefined;
    if (this.#modelPicker) {
      this.#modelPicker.handleInput(data);
      return;
    }
    if (this.#instructionInput) {
      if (matchesKey(data, Key.escape)) {
        this.#instructionInput = undefined;
      } else if (matchesKey(data, Key.enter)) {
        const input = this.#instructionInput;
        this.#instructionInput = undefined;
        this.chooseFusionModel(input);
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
      this.pendingAction = this.run(() => this.actions.retryParticipants());
    } else if (data === 'c' && this.getReview().answers.length >= 2) {
      this.pendingAction = this.run(() => this.actions.retryComparison());
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
        ...(this.#validationError ? [this.theme.fg('warning', this.#validationError)] : []),
        ...this.#instructionInput.render(width),
      ].map((line) => truncateToWidth(line, width));
    }
    const contentWidth = Math.max(1, width);
    const review = this.getReview();
    const pages = this.pages();
    this.#page = Math.min(this.#page, pages.length - 1);
    const page = pages[this.#page]!;
    const status = review.fused ? 'Synthesis ready' : review.comparison ? 'Comparison ready — synthesis has not run' : 'Comparison unavailable — retry after reviewing source answers';
    const body = new Markdown(cleanText(page.text), 0, 0, markdownTheme(this.theme), undefined, { preserveOrderedListMarkers: true }).render(contentWidth);
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
      this.context.notify(error instanceof Error ? error.message : 'Fusion action failed.', 'error');
    } finally {
      this.#busy = false;
      if (!this.#closed) this.requestRender();
    }
  }

  private fuseAndClose(instruction?: string, model?: string): void {
    this.pendingAction = this.run(() => this.actions.fuse(instruction, model));
    this.close();
  }

  private chooseFusionModel(input: Input): void {
    const instruction = input.getValue();
    if (this.context.chooseModel) {
      const error = this.context.chooseModel(instruction);
      if (error) {
        this.#validationError = error;
        this.#instructionInput = input;
        this.requestRender();
      } else this.close();
      return;
    }
    const models = this.context.getModels();
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


function markdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: text => theme.fg('mdHeading', text), link: text => theme.fg('mdLink', text),
    linkUrl: text => theme.fg('mdLinkUrl', text), code: text => theme.fg('mdCode', text),
    codeBlock: text => theme.fg('mdCodeBlock', text), codeBlockBorder: text => theme.fg('mdCodeBlockBorder', text),
    quote: text => theme.fg('mdQuote', text), quoteBorder: text => theme.fg('mdQuoteBorder', text),
    hr: text => theme.fg('mdHr', text), listBullet: text => theme.fg('mdListBullet', text),
    bold: text => theme.bold(text), italic: text => theme.italic(text),
    underline: text => theme.underline(text), strikethrough: text => theme.strikethrough(text),
  };
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
