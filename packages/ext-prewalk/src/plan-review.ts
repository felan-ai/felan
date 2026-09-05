import type { ExtensionContext } from '@felan-ai/agent-core';
import {
  CURSOR_MARKER,
  Editor,
  Key,
  Markdown,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type Keybinding,
  type KeybindingsManager,
  type MarkdownTheme,
  type OverlayOptions,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';

type Theme = ExtensionContext['ui']['theme'];

export const APPROVE_PLAN_OPTION = 'Approve plan';
export const FEEDBACK_PLAN_OPTION = 'Provide feedback';
export const CANCEL_PREWALK_OPTION = 'Cancel Prewalk';

export const PLAN_REVIEW_OPTIONS = [
  APPROVE_PLAN_OPTION,
  FEEDBACK_PLAN_OPTION,
  CANCEL_PREWALK_OPTION,
] as const;

export type PlanReviewAction = (typeof PLAN_REVIEW_OPTIONS)[number];

export interface PlanReviewResult {
  action: PlanReviewAction;
  feedback?: string;
}

interface EditorLayout {
  top: number;
  width: number;
  height: number;
  offset: number;
  fullHeight: number;
}

export const PLAN_REVIEW_OVERLAY_OPTIONS: OverlayOptions = {
  anchor: 'top-left',
  width: '100%',
  maxHeight: '100%',
  margin: 0,
};

const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

export async function presentPlanReview(
  ctx: ExtensionContext,
  plan: string,
  signal?: AbortSignal,
): Promise<PlanReviewResult | undefined> {
  if (ctx.mode !== 'tui') {
    const action = await ctx.ui.select(
      `Review Prewalk plan\n\n${plan}`,
      [...PLAN_REVIEW_OPTIONS],
      signal ? { signal } : undefined,
    );
    return isPlanReviewAction(action) ? { action } : undefined;
  }

  let removeAbortListener: (() => void) | undefined;
  try {
    return await ctx.ui.custom<PlanReviewResult | undefined>(
      (tui, theme, keybindings, done) => {
        let settled = false;
        const finish = (result: PlanReviewResult | undefined): void => {
          if (settled) return;
          settled = true;
          done(result);
        };
        const onAbort = (): void => finish(undefined);
        if (signal?.aborted) queueMicrotask(onAbort);
        else if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        }
        return new PlanReview(tui, theme, keybindings, plan, finish);
      },
      { overlay: true, overlayOptions: PLAN_REVIEW_OVERLAY_OPTIONS },
    );
  } finally {
    removeAbortListener?.();
  }
}

export class PlanReview implements Component, Focusable {
  readonly #markdown: Markdown;
  readonly #editor: Editor;
  #editorLayout: EditorLayout | undefined;
  #editingFeedback = false;
  #focused = false;
  #selectedIndex = 0;
  #scrollOffset = 0;
  #contentLength = 0;
  #viewportHeight = 1;
  #anchoredToEnd = false;
  #closed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    plan: string,
    private readonly done: (result: PlanReviewResult | undefined) => void,
  ) {
    this.#markdown = new Markdown(
      sanitizePlanForDisplay(plan),
      0,
      0,
      createPlanMarkdownTheme(theme),
      undefined,
      { preserveOrderedListMarkers: true },
    );
    this.#editor = new Editor(tui, {
      borderColor: (text) => theme.fg('accent', text),
      selectList: {
        selectedPrefix: (text) => theme.fg('accent', text),
        selectedText: (text) => theme.fg('accent', text),
        description: (text) => theme.fg('muted', text),
        scrollInfo: (text) => theme.fg('dim', text),
        noMatch: (text) => theme.fg('warning', text),
      },
    });
    this.#editor.onSubmit = (feedback) => {
      if (feedback.trim()) this.#finish({ action: FEEDBACK_PLAN_OPTION, feedback });
    };
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    this.#editor.focused = value && this.#editingFeedback;
  }

  handleInput(data: string): void {
    if (this.#closed) return;
    const wheelDirection = parseWheelDirection(data);
    if (wheelDirection !== undefined) {
      this.#scrollBy(wheelDirection);
      return;
    }
    if (this.keybindings.matches(data, 'tui.select.cancel')) {
      if (this.#editingFeedback) this.#setEditingFeedback(false);
      else this.#finish(undefined);
      return;
    }
    if (
      this.keybindings.matches(data, 'tui.select.pageUp')
      || (!this.#editingFeedback && matchesKey(data, Key.ctrl('u')))
    ) {
      this.#scrollBy(-this.#viewportHeight);
      return;
    }
    if (
      this.keybindings.matches(data, 'tui.select.pageDown')
      || (!this.#editingFeedback && matchesKey(data, Key.ctrl('d')))
    ) {
      this.#scrollBy(this.#viewportHeight);
      return;
    }
    if (this.#editingFeedback) {
      this.#editor.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.#scrollToStart();
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.#scrollToEnd();
      return;
    }
    if (this.keybindings.matches(data, 'tui.select.up') || data === 'k') {
      this.#select(-1);
      return;
    }
    if (this.keybindings.matches(data, 'tui.select.down') || data === 'j') {
      this.#select(1);
      return;
    }
    if (this.keybindings.matches(data, 'tui.select.confirm') || matchesKey(data, Key.enter)) {
      const action = PLAN_REVIEW_OPTIONS[this.#selectedIndex];
      if (action === FEEDBACK_PLAN_OPTION) this.#setEditingFeedback(true);
      else if (action) this.#finish({ action });
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.#closed) return undefined;
    if (event.type === 'wheel') {
      this.#scrollBy(Math.sign(event.wheelDelta ?? 0));
      return { handled: true };
    }
    const layout = this.#editorLayout;
    if (
      !this.#editingFeedback || !layout
      || event.x < 1 || event.x >= layout.width + 1
      || event.y < layout.top || event.y >= layout.top + layout.height
    ) return undefined;
    return this.#editor.handleMouse({
      ...event,
      x: event.x - 1,
      y: event.y - layout.top + layout.offset,
      width: layout.width,
      height: layout.fullHeight,
    });
  }

  render(width: number): string[] {
    this.#editorLayout = undefined;
    const renderWidth = normalizeDimension(width);
    const rows = normalizeDimension(this.tui.terminal.rows);
    if (rows === 1) return [fitLine(this.theme.fg('border', '─'.repeat(renderWidth)), renderWidth)];

    const innerWidth = renderWidth >= 3 ? renderWidth - 2 : 0;
    const innerRows = Math.max(0, rows - 2);
    const feedback = this.#editingFeedback
      ? this.#renderFeedback(innerWidth, Math.min(innerRows, Math.max(1, innerRows - 3)))
      : undefined;
    const feedbackLines = feedback?.lines;
    const actionRows = feedbackLines?.length ?? Math.min(PLAN_REVIEW_OPTIONS.length, innerRows);
    let viewportHeight = Math.max(0, innerRows - actionRows);
    const showHeader = viewportHeight >= 2;
    if (showHeader) viewportHeight -= 1;
    const showDivider = !this.#editingFeedback && viewportHeight >= 2;
    if (showDivider) viewportHeight -= 1;
    const showHints = viewportHeight >= 2;
    if (showHints) viewportHeight -= 1;

    const content = innerWidth > 0 ? this.#markdown.render(innerWidth) : [];
    const previousMaxScroll = Math.max(0, this.#contentLength - this.#viewportHeight);
    const wasAtEnd = this.#anchoredToEnd && this.#scrollOffset === previousMaxScroll;
    this.#contentLength = content.length;
    this.#viewportHeight = Math.max(1, viewportHeight);
    const maxScroll = this.#maxScroll();
    this.#scrollOffset = wasAtEnd
      ? maxScroll
      : Math.max(0, Math.min(this.#scrollOffset, maxScroll));

    const body: string[] = [];
    if (showHeader) body.push(this.#renderHeader());
    const visiblePlan = content.slice(this.#scrollOffset, this.#scrollOffset + viewportHeight);
    body.push(...visiblePlan);
    while (body.length < Number(showHeader) + viewportHeight) body.push('');
    if (showDivider) body.push(this.theme.fg('border', '─'.repeat(innerWidth)));
    const feedbackTop = body.length + 1;
    body.push(...(feedbackLines ?? this.#renderActions(innerWidth, actionRows)));
    if (showHints) body.push(this.#renderHints());
    this.#editorLayout = feedback?.editorLayout;
    if (this.#editorLayout) {
      this.#editorLayout.top += feedbackTop + Math.max(0, innerRows - body.length);
    }
    while (body.length < innerRows) body.unshift('');

    return frameLines(body.slice(-innerRows), renderWidth, this.theme);
  }

  invalidate(): void {
    this.#markdown.invalidate();
    this.#editor.invalidate();
  }

  dispose(): void {
    this.#closed = true;
  }

  #finish(result: PlanReviewResult | undefined): void {
    if (this.#closed) return;
    this.#closed = true;
    this.done(result);
  }

  #setEditingFeedback(editing: boolean): void {
    this.#editingFeedback = editing;
    this.#editorLayout = undefined;
    this.#editor.focused = editing && this.#focused;
    this.tui.requestRender();
  }

  #select(delta: number): void {
    const next = Math.max(0, Math.min(PLAN_REVIEW_OPTIONS.length - 1, this.#selectedIndex + delta));
    if (next === this.#selectedIndex) return;
    this.#selectedIndex = next;
    this.tui.requestRender();
  }

  #scrollBy(delta: number): void {
    const next = Math.max(0, Math.min(this.#maxScroll(), this.#scrollOffset + delta));
    if (next === this.#scrollOffset) return;
    this.#scrollOffset = next;
    this.#anchoredToEnd = next === this.#maxScroll();
    this.tui.requestRender();
  }

  #scrollToStart(): void {
    if (this.#scrollOffset === 0 && !this.#anchoredToEnd) return;
    this.#scrollOffset = 0;
    this.#anchoredToEnd = false;
    this.tui.requestRender();
  }

  #scrollToEnd(): void {
    const maxScroll = this.#maxScroll();
    if (this.#scrollOffset === maxScroll && this.#anchoredToEnd) return;
    this.#scrollOffset = maxScroll;
    this.#anchoredToEnd = true;
    this.tui.requestRender();
  }

  #maxScroll(): number {
    return Math.max(0, this.#contentLength - this.#viewportHeight);
  }

  #renderHeader(): string {
    const start = this.#contentLength === 0 ? 0 : this.#scrollOffset + 1;
    const end = Math.min(this.#contentLength, this.#scrollOffset + this.#viewportHeight);
    return this.theme.fg('accent', this.theme.bold('Review Prewalk plan'))
      + this.theme.fg('dim', `  lines ${start}-${end}/${this.#contentLength}`);
  }

  #renderActions(width: number, maxRows: number): string[] {
    if (maxRows <= 0) return [];
    const start = Math.max(
      0,
      Math.min(this.#selectedIndex - maxRows + 1, PLAN_REVIEW_OPTIONS.length - maxRows),
    );
    return PLAN_REVIEW_OPTIONS.slice(start, start + maxRows).map((option, offset) => {
      const selected = start + offset === this.#selectedIndex;
      const marker = selected ? this.theme.fg('accent', '→ ') : '  ';
      const label = selected
        ? this.theme.fg('accent', this.theme.bold(option))
        : this.theme.fg('text', option);
      return fitLine(`${marker}${label}`, width);
    });
  }

  #renderHints(): string {
    const pageUp = bindingLabel(this.keybindings, 'tui.select.pageUp', 'pageUp');
    const pageDown = bindingLabel(this.keybindings, 'tui.select.pageDown', 'pageDown');
    const cancel = bindingLabel(this.keybindings, 'tui.select.cancel', 'escape');
    if (this.#editingFeedback) {
      const submit = bindingLabel(this.keybindings, 'tui.input.submit', 'enter');
      const newLine = bindingLabel(this.keybindings, 'tui.input.newLine', 'shift+enter/ctrl+j');
      return this.theme.fg('dim', `${submit} send · ${newLine} newline · ${cancel} back`);
    }
    const selectUp = bindingLabel(this.keybindings, 'tui.select.up', 'up');
    const selectDown = bindingLabel(this.keybindings, 'tui.select.down', 'down');
    const confirm = bindingLabel(this.keybindings, 'tui.select.confirm', 'enter');
    return this.theme.fg(
      'dim',
      `wheel or ${pageUp}/${pageDown} scroll · home/end limits · ${selectUp}/${selectDown} choose · ${confirm} select · ${cancel} dismiss`,
    );
  }

  #renderFeedback(width: number, maxRows: number): { lines: string[]; editorLayout?: EditorLayout } {
    if (maxRows <= 0) return { lines: [] };
    if (width <= 0) return { lines: [''] };
    const pageUp = bindingLabel(this.keybindings, 'tui.select.pageUp', 'pageUp');
    const pageDown = bindingLabel(this.keybindings, 'tui.select.pageDown', 'pageDown');
    const label = this.theme.fg('accent', this.theme.bold('Feedback'))
      + this.theme.fg('dim', ` · wheel/${pageUp}/${pageDown} scroll plan`);
    const header = maxRows >= 2 ? [label] : [];
    const editorRows = maxRows - header.length;
    const lines = this.#editor.render(width);
    let visibleLines = lines;
    let offset = 0;
    if (lines.length > editorRows) {
      const content = lines.slice(1, -1);
      const cursorRow = content.findIndex((line) => line.includes(CURSOR_MARKER));
      const start = Math.max(0, Math.min(cursorRow, content.length - editorRows));
      visibleLines = content.slice(start, start + editorRows);
      offset = start + 1;
    }
    return {
      lines: [...header, ...visibleLines],
      editorLayout: {
        top: header.length,
        width,
        height: visibleLines.length,
        offset,
        fullHeight: lines.length,
      },
    };
  }
}

export function sanitizePlanForDisplay(plan: string): string {
  return stripTerminalSequences(plan)
    .replace(/\r\n?/gu, '\n')
    .replace(UNSAFE_CONTROL_CHARACTERS, ' ');
}

function createPlanMarkdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text) => theme.fg('mdHeading', text),
    link: (text) => theme.fg('mdLink', text),
    linkUrl: (text) => theme.fg('mdLinkUrl', text),
    code: (text) => theme.fg('mdCode', text),
    codeBlock: (text) => theme.fg('mdCodeBlock', text),
    codeBlockBorder: (text) => theme.fg('mdCodeBlockBorder', text),
    quote: (text) => theme.fg('mdQuote', text),
    quoteBorder: (text) => theme.fg('mdQuoteBorder', text),
    hr: (text) => theme.fg('mdHr', text),
    listBullet: (text) => theme.fg('mdListBullet', text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    underline: (text) => theme.underline(text),
    strikethrough: (text) => theme.strikethrough(text),
  };
}

function bindingLabel(
  keybindings: KeybindingsManager,
  binding: Keybinding,
  fallback: string,
): string {
  const keys = keybindings.getKeys(binding);
  return keys.length > 0 ? keys.join('/') : fallback;
}

function isPlanReviewAction(action: string | undefined): action is PlanReviewAction {
  return PLAN_REVIEW_OPTIONS.some((option) => option === action);
}

function normalizeDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function parseWheelDirection(data: string): -1 | 1 | undefined {
  const sgr = /^\x1b\[<(\d+);\d+;\d+[Mm]$/u.exec(data);
  const button = sgr?.[1];
  if (button !== undefined) return wheelDirection(Number.parseInt(button, 10));
  if (data.length === 6 && data.startsWith('\x1b[M')) {
    return wheelDirection(data.charCodeAt(3) - 32);
  }
  return undefined;
}

function wheelDirection(button: number): -1 | 1 | undefined {
  if ((button & 64) === 0) return undefined;
  const direction = button & 3;
  if (direction === 0) return -1;
  if (direction === 1) return 1;
  return undefined;
}

function fitLine(line: string, width: number): string {
  if (width <= 0) return '';
  const truncated = truncateToWidth(line, width, '', true);
  return truncated + ' '.repeat(Math.max(0, width - visibleWidth(truncated)));
}

function frameLines(lines: readonly string[], width: number, theme: Theme): string[] {
  const border = (text: string): string => theme.fg('border', text);
  if (width === 1) {
    return [border('╭'), ...lines.map((line) => fitLine(line, 1)), border('╰')];
  }
  const innerWidth = Math.max(0, width - 2);
  return [
    border(`╭${'─'.repeat(innerWidth)}╮`),
    ...lines.map((line) => `${border('│')}${fitLine(line, innerWidth)}${border('│')}`),
    border(`╰${'─'.repeat(innerWidth)}╯`),
  ];
}
