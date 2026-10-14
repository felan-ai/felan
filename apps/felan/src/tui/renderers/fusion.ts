import { createElementNavigation } from './navigation.js';
import { decodeUiMarkdown } from '../../client/ui.js';
import { Key, Input, matchesKey, truncateToWidth, Markdown, wrapTextWithAnsi, type Component, type Focusable, type MarkdownTheme, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui';
import type { ExtensionCommandContext, Theme } from '@felan-ai/agent-core';
import {
  parseUiPresentation, validateUiAction,
  type UiActionRequest, type UiAction, type UiDocument, type UiPresentation, type UiValues, type UiView,
} from '@felan-ai/session-protocol';

const navigation = createElementNavigation<{ itemId?: string; actionId?: string; scroll: number }>();

type FusionUi = Pick<ExtensionCommandContext['ui'], 'custom' | 'notify'>;

export function presentFusionPickerView(
  element: UiPresentation, ui: Pick<FusionUi, 'custom'>, signal: AbortSignal,
): Promise<UiActionRequest | undefined> {
  const view = parseUiPresentation(element);
  if (view.kind !== 'view') throw new Error('Fusion picker requires a view.');
  return presentFusionElement(view, ui, signal);
}

export function presentFusionReviewDocument(
  element: UiPresentation, ui: Pick<FusionUi, 'custom'>, signal: AbortSignal,
): Promise<UiActionRequest | undefined> {
  const document = parseUiPresentation(element);
  if (document.kind !== 'document') throw new Error('Fusion review requires a document.');
  return presentFusionElement(document, ui, signal);
}

async function presentFusionElement(
  element: UiView | UiDocument, ui: Pick<FusionUi, 'custom'>, signal: AbortSignal,
): Promise<UiActionRequest | undefined> {
  if (signal.aborted) return undefined;
  if (element.actions.some(action => action.input?.fields.some(field => field.kind !== 'string'))) {
    throw new Error('Fusion hint renderer requires string action inputs.');
  }
  let removeAbort: (() => void) | undefined;
  try {
    const result = await ui.custom<UiActionRequest | undefined>((tui, theme, _keys, done) => {
      let settled = false;
      const finish = (request: UiActionRequest | undefined) => {
        if (settled) return;
        settled = true; panel.dispose();
        if (request && ['cancel', 'save', 'close'].includes(request.actionId)) navigation.delete(element.id);
        done(request);
      };
      const panel = new FusionVocabularyPanel(element, theme, () => tui.requestRender(), finish, () => tui.terminal?.rows ?? 30);
      const abort = () => finish(undefined);
      if (signal.aborted) queueMicrotask(abort);
      else { signal.addEventListener('abort', abort, { once: true }); removeAbort = () => signal.removeEventListener('abort', abort); }
      return panel;
    }, { overlay: true, overlayOptions: { anchor: 'top-left', width: '100%', maxHeight: '100%', margin: 0 } });
    return signal.aborted ? undefined : result;
  } finally { removeAbort?.(); }
}

class FusionVocabularyPanel implements Component, Focusable {
  private selectedItem = 0;
  private selectedAction = 0;
  private scroll = 0;
  private viewport = 12;
  private maximumScroll = 0;
  private closed = false;
  private hasFocus = false;
  private error: string | undefined;
  private editing: { action: UiAction; inputs: Input[]; index: number } | undefined;

  constructor(
    private readonly element: UiView | UiDocument,
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly done: (result: UiActionRequest | undefined) => void,
    private readonly terminalRows: () => number,
  ) {
    const initial = navigation.get(element.id);
    if (element.kind === 'view') {
      this.selectedItem = Math.max(0, element.items.findIndex(item => item.id === initial?.itemId));
      this.selectedAction = Math.max(0, element.actions.findIndex(action => action.id === initial?.actionId || !initial && action.target === 'item'));
    }
    this.scroll = initial?.scroll ?? 0;
  }

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.editing?.inputs.forEach((input, index) => { input.focused = value && index === this.editing!.index; });
  }
  dispose(): void {
    navigation.set(this.element.id, { ...(this.element.kind === 'view' && this.element.items[this.selectedItem] ? { itemId: this.element.items[this.selectedItem]!.id } : {}),
      ...(this.element.actions[this.selectedAction] ? { actionId: this.element.actions[this.selectedAction]!.id } : {}), scroll: this.scroll });
    this.closed = true;
  }
  invalidate(): void { this.editing?.inputs.forEach(input => input.invalidate()); }

  handleInput(data: string): void {
    if (this.closed) return;
    this.error = undefined;
    const edit = this.editing;
    if (edit) {
      if (matchesKey(data, Key.escape)) this.editing = undefined;
      else if (matchesKey(data, Key.tab)) {
        edit.index = (edit.index + 1) % edit.inputs.length; this.focused = this.hasFocus;
      } else if (matchesKey(data, Key.enter)) {
        if (edit.index + 1 < edit.inputs.length) { edit.index++; this.focused = this.hasFocus; }
        else {
          const values: UiValues = {};
          edit.action.input!.fields.forEach((field, index) => {
            const value = edit.inputs[index]!.getValue();
            if (value || field.required) values[field.id] = value;
          });
          this.submit(edit.action, values);
        }
      } else edit.inputs[edit.index]!.handleInput(data);
      this.requestRender(); return;
    }
    if (matchesKey(data, Key.escape)) {
      const cancel = this.element.actions.find(action => action.target === 'element' && action.outcome === 'cancel');
      if (cancel) this.activate(cancel); else this.done(undefined);
    } else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      this.scrollBy(matchesKey(data, Key.pageUp) ? -this.viewport : this.viewport);
    } else if (matchesKey(data, Key.home) || matchesKey(data, Key.end)) {
      this.scroll = matchesKey(data, Key.home) ? 0 : this.maximumScroll;
    } else if (this.element.kind === 'view' && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
      const id = matchesKey(data, Key.left) ? this.element.paging?.previousActionId : this.element.paging?.nextActionId;
      this.activateId(id);
    } else if (this.element.kind === 'view' && data === '/') {
      this.activateId(this.element.query?.actionId);
    } else if (this.element.kind === 'view' && matchesKey(data, Key.ctrl('s'))) {
      this.activateId('save');
    } else if (this.element.kind === 'view' && matchesKey(data, Key.ctrl('l'))) {
      this.activateId('clear');
    } else if (matchesKey(data, Key.tab)) {
      this.selectedAction = (this.selectedAction + 1) % Math.max(1, this.element.actions.length);
    } else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const delta = matchesKey(data, Key.up) ? -1 : 1;
      if (this.element.kind === 'view') {
        this.selectedItem = Math.max(0, Math.min(this.element.items.length - 1, this.selectedItem + delta));
      } else this.selectedAction = Math.max(0, Math.min(this.element.actions.length - 1, this.selectedAction + delta));
    } else if (matchesKey(data, Key.enter)) this.activate(this.element.actions[this.selectedAction]);
    this.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed || event.type !== 'wheel' || this.editing) return undefined;
    this.scrollBy(Math.sign(event.wheelDelta ?? 0) * 3);
    return { handled: true };
  }

  private scrollBy(delta: number): void {
    this.scroll = Math.max(0, Math.min(this.maximumScroll, this.scroll + delta)); this.requestRender();
  }

  private activateId(id: string | undefined): void {
    this.activate(this.element.actions.find(action => action.id === id));
  }

  private activate(action: UiAction | undefined): void {
    if (!action || action.target === 'item' && (this.element.kind !== 'view' || !this.element.items[this.selectedItem])) return;
    if (!action.input?.fields.length) { this.submit(action, {}); return; }
    this.editing = { action, index: 0, inputs: action.input.fields.map(field => {
      const input = new Input({ placeholder: field.kind === 'string' ? cleanLabel(field.placeholder ?? field.label) : '' });
      const defaults = this.element.kind === 'view' && this.element.query?.actionId === action.id
        ? this.element.query.values : action.input?.defaults;
      const value = defaults?.[field.id];
      if (typeof value === 'string') { input.setValue(cleanLabel(value)); input.handleInput('\x1b[F'); }
      return input;
    }) };
    this.focused = this.hasFocus;
  }

  private submit(action: UiAction, values: UiValues): void {
    try {
      const request = validateUiAction(this.element, {
        elementId: this.element.id, revision: this.element.revision, actionId: action.id, outcome: action.outcome, values,
        ...(action.target === 'item' && this.element.kind === 'view' ? { itemId: this.element.items[this.selectedItem]?.id } : {}),
      });
      this.done(request);
    } catch (error) { this.error = cleanLabel(error instanceof Error ? error.message : 'Invalid Fusion action.'); }
  }

  render(width: number): string[] {
    width = Math.max(1, Math.floor(width));
    const header = [this.theme.fg('accent', this.theme.bold(cleanLabel(this.element.title))),
      ...wrapTextWithAnsi(cleanLabel(this.element.fallback), width)];
    if (this.editing) {
      const edit = this.editing;
      return [...header, cleanLabel(edit.action.label),
        ...edit.action.input!.fields.flatMap((field, index) => [
          `${index === edit.index ? '→' : ' '} ${cleanLabel(field.label)}${field.required ? ' (required)' : ' (optional)'}`,
          ...edit.inputs[index]!.render(width),
        ]), ...(this.error ? [this.theme.fg('warning', this.error)] : []),
        'Enter next / submit · Tab switch field · Esc back'].map(line => truncateToWidth(line, width));
    }
    const footer = [
      ...this.element.actions.map((action, index) => `${index === this.selectedAction ? '→' : ' '} ${cleanLabel(action.label)}${action.target === 'item' ? ' (selected model)' : ''}`),
      ...(this.error ? [this.theme.fg('warning', this.error)] : []),
      ...(this.element.kind === 'view'
        ? ['↑/↓ models · Tab actions · Enter select · / search · ←/→ pages · Ctrl+S save · Ctrl+L clear · Esc cancel']
        : ['↑/↓ actions · Enter select · PgUp/PgDn / mouse wheel scroll · Esc close']),
    ];
    const view = this.element.kind === 'view' ? this.element : undefined;
    const rows = view?.items.map((item, index) => wrapTextWithAnsi(
      `${index === this.selectedItem ? '→' : ' '} ${view.fields.map(field =>
        `${cleanLabel(field.label)}: ${cleanLabel(String(item.values[field.id] ?? '—'))}`).join(' · ')}`, width)) ?? [];
    const body = this.element.kind === 'document'
      ? new Markdown(cleanText(decodeUiMarkdown(this.element.markdown)), 0, 0, markdownTheme(this.theme), undefined, { preserveOrderedListMarkers: true }).render(width)
      : rows.flat();
    this.viewport = Math.max(1, this.terminalRows() - header.length - footer.length - 2);
    this.maximumScroll = Math.max(0, body.length - this.viewport);
    if (this.element.kind === 'view') {
      const offset = rows.slice(0, this.selectedItem).reduce((count, row) => count + row.length, 0);
      if (offset < this.scroll || offset >= this.scroll + this.viewport) this.scroll = offset;
    }
    this.scroll = Math.min(this.scroll, this.maximumScroll);
    return [...header, '', ...body.slice(this.scroll, this.scroll + this.viewport), '', ...footer]
      .map(line => truncateToWidth(line, width));
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

function cleanText(value: string): string {
  return value
    .replace(/\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, ' ');
}

function cleanLabel(value: string): string {
  return cleanText(value).replace(/[\u0000-\u001f]/gu, ' ');
}
