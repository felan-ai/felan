import type { ExtensionContext } from '@felan-ai/agent-core';
import { createRequire } from 'node:module';
import {
  Container,
  decodeKittyPrintable,
  Editor,
  fuzzyFilter,
  Key,
  matchesKey,
  Spacer,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type Keybinding,
  type KeybindingsManager,
  type OverlayHandle,
  type SizeValue,
  type TUI,
} from '@earendil-works/pi-tui';
import type {
  AskUserHost,
  AskUserHostOutcome,
  AskUserOption,
  AskUserQuestion,
  AskUserQuestionAnswer,
  AskUserRequest,
  AskUserResponse,
  AskUserSingleSelectLayout,
  AskUserToolDetails,
  AskUserToolErrorDetails,
  AskUserToolPresentation,
} from './contracts.js';
import { normalizeAskUserOption } from './normalize.js';
import { renderSingleSelectRows } from './single-select-layout.js';

type Theme = ExtensionContext['ui']['theme'];
type AskMode = 'select' | 'freeform' | 'comment';
type Done = (result: AskUserResponse | null) => void;

const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
const BOX_LEFT = '│ ';
const BOX_RIGHT = ' │';
const BOX_OVERHEAD = BOX_LEFT.length + BOX_RIGHT.length;
const OVERLAY_MAX_HEIGHT_RATIO = 0.85;
const OVERLAY_MIN_RENDER_LINES = 8;
const OVERLAY_WIDTH: SizeValue = '92%';
const OVERLAY_MAX_HEIGHT: SizeValue = '85%';
const OVERLAY_MIN_WIDTH = 40;
const SPLIT_PANE_MIN_WIDTH = 84;
const SPLIT_LEFT_MIN_WIDTH = 32;
const SPLIT_RIGHT_MIN_WIDTH = 28;
const SPLIT_SEPARATOR = ' │ ';
const COMMENT_LABEL = 'Add extra context after selection';
const DEFAULT_OVERLAY_TOGGLE = 'alt+o';
const DEFAULT_COMMENT_TOGGLE = 'ctrl+g';
const CONTEXT_TOGGLE_KEY = Key.ctrl('e');
const INLINE_CONTEXT_MAX_ROWS = 3;
const FREEFORM_SENTINEL = 'Type custom response...';
const DISABLED_VALUES = new Set(['off', 'none', 'disabled', '']);

type ResolvedShortcut =
  | { readonly disabled: false; readonly spec: string; matches(data: string): boolean }
  | { readonly disabled: true; readonly spec: null; matches(data: string): false };

interface ResolvedShortcuts {
  readonly overlayToggle: ResolvedShortcut;
  readonly commentToggle: ResolvedShortcut;
}

const DISABLED_SHORTCUT: ResolvedShortcut = {
  disabled: true,
  spec: null,
  matches: (_data: string): false => false,
};

export function createTuiAskUserHost(): AskUserHost {
  return {
    ask: presentAskUser,
    toolPresentation,
  };
}

async function presentAskUser(
  request: AskUserRequest,
  execution: Parameters<AskUserHost['ask']>[1],
): Promise<AskUserHostOutcome> {
  const ctx = execution.extensionContext;
  if (!ctx.hasUI || (ctx.mode !== 'tui' && ctx.mode !== 'rpc')) {
    return {
      status: 'cancelled',
      reason: 'unavailable',
      message: `ask_user requires TUI or RPC dialog mode; current mode is ${ctx.mode}`,
    };
  }

  const displayMode = resolveDisplayMode(request.displayMode);
  const singleSelectLayout = resolveSingleSelectLayout(request.singleSelectLayout);
  const shortcuts: ResolvedShortcuts = {
    overlayToggle: resolveShortcut(
      request.overlayToggleKey,
      process.env.PI_ASK_USER_OVERLAY_TOGGLE_KEY,
      DEFAULT_OVERLAY_TOGGLE,
    ),
    commentToggle: resolveShortcut(
      request.commentToggleKey,
      process.env.PI_ASK_USER_COMMENT_TOGGLE_KEY,
      DEFAULT_COMMENT_TOGGLE,
    ),
  };
  let timedOut = false;
  let aborted = false;

  if (ctx.mode === 'rpc') {
    const dialogResult = await askQuestionsViaDialogs(
      ctx.ui,
      request.questions,
      request.timeout,
      execution.signal,
    );
    if (dialogResult.cancelled) return { status: 'cancelled', reason: dialogResult.cancelled };
    return dialogResult.answers.some((answer) => answer.response !== null)
      ? { status: 'answered', answers: dialogResult.answers }
      : { status: 'cancelled', reason: 'user' };
  }

  let overlayHandle: OverlayHandle | undefined;
  let removeOverlayListener: (() => void) | undefined;
  let removeAbortListener: (() => void) | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let announcedHidden = false;
  try {
    const overlayToggle = shortcuts.overlayToggle;
    if (displayMode === 'overlay' && !overlayToggle.disabled && typeof ctx.ui.onTerminalInput === 'function') {
      removeOverlayListener = ctx.ui.onTerminalInput((data) => {
        if (!overlayHandle || !overlayToggle.matches(data)) return undefined;
        const hidden = !overlayHandle.isHidden();
        overlayHandle.setHidden(hidden);
        if (hidden && !announcedHidden) {
          announcedHidden = true;
          ctx.ui.notify?.(`ask_user hidden — press ${overlayToggle.spec} to reopen`, 'info');
        }
        return { consume: true };
      });
    }

    const result = await ctx.ui.custom<readonly AskUserQuestionAnswer[] | null>(
      (tui, theme, keybindings, done) => {
        let settled = false;
        const finish = (value: readonly AskUserQuestionAnswer[] | null): void => {
          if (settled) return;
          settled = true;
          done(value);
        };
        const onAbort = () => {
          aborted = true;
          finish(null);
        };
        execution.signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => execution.signal.removeEventListener('abort', onAbort);
        if (request.timeout !== undefined) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            finish(null);
          }, request.timeout);
        }
        if (request.questions.length === 1) {
          const question = request.questions[0]!;
          return new AskPrompt(
            question,
            displayMode,
            singleSelectLayout,
            tui,
            theme,
            keybindings,
            shortcuts,
            (response) => finish(response === null ? null : [{ questionId: question.id, response }]),
          );
        }
        return new AskWizard(
          request.questions,
          displayMode,
          singleSelectLayout,
          tui,
          theme,
          keybindings,
          shortcuts,
          execution.reportProgress,
          finish,
        );
      },
      customUIOptions(displayMode, (handle) => {
        overlayHandle = handle;
      }),
    );

    if (result === undefined) {
      const dialogResult = await askQuestionsViaDialogs(
        ctx.ui,
        request.questions,
        request.timeout,
        execution.signal,
      );
      if (dialogResult.cancelled) return { status: 'cancelled', reason: dialogResult.cancelled };
      return dialogResult.answers.some((answer) => answer.response !== null)
        ? { status: 'answered', answers: dialogResult.answers }
        : { status: 'cancelled', reason: 'user' };
    }
    if (result === null) {
      return {
        status: 'cancelled',
        reason: timedOut ? 'timeout' : aborted || execution.signal.aborted ? 'abort' : 'user',
      };
    }
    return { status: 'answered', answers: result };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    removeAbortListener?.();
    removeOverlayListener?.();
  }
}

function resolveDisplayMode(value: AskUserRequest['displayMode']): 'overlay' | 'inline' {
  if (value) return value;
  const environment = process.env.PI_ASK_USER_DISPLAY_MODE?.trim().toLowerCase();
  return environment === 'inline' || environment === 'overlay' ? environment : 'overlay';
}

function resolveSingleSelectLayout(value: AskUserRequest['singleSelectLayout']): AskUserSingleSelectLayout {
  if (value) return value;
  return process.env.PI_ASK_USER_SINGLE_SELECT_LAYOUT?.trim().toLowerCase() === 'list' ? 'list' : 'auto';
}

function resolveShortcut(
  parameter: string | null | undefined,
  environment: string | undefined,
  fallback: string,
): ResolvedShortcut {
  for (const value of [parameter, environment, fallback]) {
    if (value === undefined) continue;
    if (value === null) return DISABLED_SHORTCUT;
    const normalized = value.trim().toLowerCase();
    if (DISABLED_VALUES.has(normalized)) return DISABLED_SHORTCUT;
    if (!/^[a-z0-9+_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]+$/i.test(normalized)) continue;
    if (normalized.startsWith('+') || normalized.endsWith('+') || normalized.includes('++')) continue;
    return { disabled: false, spec: normalized, matches: (data) => matchesKey(data, normalized as any) };
  }
  return DISABLED_SHORTCUT;
}

function customUIOptions(displayMode: 'overlay' | 'inline', onHandle: (handle: OverlayHandle) => void) {
  if (displayMode === 'inline') return undefined;
  return {
    overlay: true,
    overlayOptions: {
      anchor: 'center' as const,
      width: OVERLAY_WIDTH,
      minWidth: OVERLAY_MIN_WIDTH,
      maxHeight: OVERLAY_MAX_HEIGHT,
      margin: 1,
    },
    onHandle,
  };
}

function overlayMaxRenderLines(terminalRows: number): number {
  const rows = Number.isFinite(terminalRows) ? Math.max(1, Math.floor(terminalRows)) : 24;
  const availableRows = Math.max(1, rows - 2);
  const ratioRows = Math.max(1, Math.floor(rows * OVERLAY_MAX_HEIGHT_RATIO));
  const minimumRows = Math.min(OVERLAY_MIN_RENDER_LINES, availableRows);
  return Math.min(availableRows, Math.max(minimumRows, ratioRows));
}

class BorderTop implements Component {
  constructor(
    private readonly color: (text: string) => string,
    private readonly title: string,
    private readonly titleColor: (text: string) => string,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const inner = Math.max(0, width - 2);
    if (inner < this.title.length + 4) return [this.color(`╭${'─'.repeat(inner)}╮`)];
    const label = ` ${this.title} `;
    return [
      this.color('╭─')
      + this.titleColor(label)
      + this.color(`${'─'.repeat(Math.max(0, inner - label.length - 1))}╮`),
    ];
  }
}

class BorderBottom implements Component {
  constructor(
    private readonly color: (text: string) => string,
    private readonly label: string,
    private readonly labelColor: (text: string) => string,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const inner = Math.max(0, width - 2);
    if (inner < this.label.length + 4) return [this.color(`╰${'─'.repeat(inner)}╯`)];
    const tag = ` ${this.label} `;
    return [
      this.color(`╰${'─'.repeat(Math.max(0, inner - tag.length - 1))}`)
      + this.labelColor(tag)
      + this.color('─╯'),
    ];
  }
}

function createEditorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (text) => theme.fg('accent', text),
    selectList: {
      selectedPrefix: (text) => theme.fg('accent', text),
      selectedText: (text) => theme.fg('accent', text),
      description: (text) => theme.fg('muted', text),
      scrollInfo: (text) => theme.fg('dim', text),
      noMatch: (text) => theme.fg('warning', text),
    },
  };
}

function keyHint(theme: Theme, keybindings: KeybindingsManager, binding: Keybinding, description: string): string {
  return `${theme.fg('dim', keybindings.getKeys(binding).join('/'))}${theme.fg('muted', ` ${description}`)}`;
}

function literalHint(theme: Theme, key: string, description: string): string {
  return `${theme.fg('dim', key)}${theme.fg('muted', ` ${description}`)}`;
}

function matchesUp(data: string, keybindings: KeybindingsManager): boolean {
  return keybindings.matches(data, 'tui.select.up')
    || matchesKey(data, Key.shift('tab'))
    || matchesKey(data, Key.ctrl('k'));
}

function matchesDown(data: string, keybindings: KeybindingsManager): boolean {
  return keybindings.matches(data, 'tui.select.down')
    || matchesKey(data, Key.tab)
    || matchesKey(data, Key.ctrl('j'));
}

function matchesSubmit(data: string, keybindings: KeybindingsManager): boolean {
  return keybindings.matches(data, 'tui.select.confirm')
    || keybindings.matches(data, 'tui.input.submit')
    || matchesKey(data, Key.enter)
    || matchesKey(data, Key.return);
}

class MultiSelectList implements Component {
  private selectedIndex = 0;
  private readonly checked = new Set<number>();
  private commentEnabled = false;
  private maxVisibleRows = 10;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  onCancel?: () => void;
  onSubmit?: (selections: string[], commentEnabled: boolean) => void;
  onEnterFreeform?: () => void;

  constructor(
    private readonly options: readonly AskUserOption[],
    private readonly allowFreeform: boolean,
    private readonly allowComment: boolean,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly commentToggle: ResolvedShortcut,
  ) {}

  setMaxVisibleRows(rows: number): void {
    const normalized = Math.max(1, Math.floor(rows));
    if (normalized !== this.maxVisibleRows) {
      this.maxVisibleRows = normalized;
      this.invalidate();
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, 'tui.select.cancel')) return this.onCancel?.();
    const count = this.itemCount();
    if (count === 0) return this.onCancel?.();
    if (this.allowComment && !this.commentToggle.disabled && this.commentToggle.matches(data)) {
      this.toggleComment();
      return;
    }
    if (matchesUp(data, this.keybindings)) {
      this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
      this.invalidate();
      return;
    }
    if (matchesDown(data, this.keybindings)) {
      this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
      this.invalidate();
      return;
    }
    const number = data.match(/^[1-9]$/);
    if (number) {
      const index = Number(number[0]) - 1;
      if (index < this.options.length) {
        this.toggle(index);
        this.selectedIndex = index;
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.space)) {
      if (this.isCommentRow(this.selectedIndex)) return this.toggleComment();
      if (this.isFreeformRow(this.selectedIndex)) return this.onEnterFreeform?.();
      this.toggle(this.selectedIndex);
      this.invalidate();
      return;
    }
    if (!matchesSubmit(data, this.keybindings)) return;
    if (this.isCommentRow(this.selectedIndex)) return this.toggleComment();
    if (this.isFreeformRow(this.selectedIndex)) return this.onEnterFreeform?.();
    const selections = [...this.checked]
      .sort((left, right) => left - right)
      .map((index) => this.options[index]?.title)
      .filter((title): title is string => title !== undefined);
    const fallback = this.options[this.selectedIndex]?.title;
    const result = selections.length > 0 ? selections : fallback ? [fallback] : [];
    if (result.length > 0) this.onSubmit?.(result, this.commentEnabled);
    else this.onCancel?.();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const count = this.itemCount();
    if (count === 0) return [this.theme.fg('warning', 'No options')];
    const blocks: string[][] = [];
    for (let index = 0; index < count; index += 1) {
      const active = index === this.selectedIndex;
      const pointer = active ? this.theme.fg('accent', '→') : ' ';
      const block: string[] = [];
      if (this.isCommentRow(index)) {
        const check = this.commentEnabled ? this.theme.fg('success', '[✓]') : this.theme.fg('dim', '[ ]');
        block.push(truncateToWidth(`${pointer}   ${check} ${this.theme.fg(active ? 'accent' : 'text', COMMENT_LABEL)}`, width, ''));
        blocks.push(block);
        continue;
      }
      if (this.isFreeformRow(index)) {
        block.push(truncateToWidth(`${pointer}   ${this.theme.fg(active ? 'accent' : 'text', 'Type something.')} ${this.theme.fg('muted', '— Enter a custom response')}`, width, ''));
        blocks.push(block);
        continue;
      }
      const option = this.options[index]!;
      const check = this.checked.has(index) ? this.theme.fg('success', '[✓]') : this.theme.fg('dim', '[ ]');
      block.push(truncateToWidth(`${pointer} ${this.theme.fg('dim', `${index + 1}.`)} ${check} ${this.theme.fg(active ? 'accent' : 'text', this.theme.bold(option.title))}`, width, ''));
      if (option.description) {
        for (const line of wrapTextWithAnsi(option.description, Math.max(10, width - 6))) {
          block.push(truncateToWidth(`      ${this.theme.fg('muted', line)}`, width, ''));
        }
      }
      blocks.push(block);
    }

    const totalRows = blocks.reduce((sum, block) => sum + block.length, 0);
    let lines: string[];
    if (totalRows <= this.maxVisibleRows) {
      lines = blocks.flat();
    } else {
      const availableRows = this.maxVisibleRows > 1 ? this.maxVisibleRows - 1 : 1;
      const selectedBlock = blocks[this.selectedIndex] ?? blocks[0] ?? [];
      if (selectedBlock.length >= availableRows) {
        lines = selectedBlock.slice(0, availableRows);
      } else {
        let start = this.selectedIndex;
        let end = this.selectedIndex + 1;
        let usedRows = selectedBlock.length;
        while (true) {
          const next = blocks[end];
          if (next && usedRows + next.length <= availableRows) {
            usedRows += next.length;
            end += 1;
            continue;
          }
          const previous = blocks[start - 1];
          if (previous && usedRows + previous.length <= availableRows) {
            start -= 1;
            usedRows += previous.length;
            continue;
          }
          break;
        }
        lines = blocks.slice(start, end).flat();
      }
      if (this.maxVisibleRows > 1) {
        lines.push(this.theme.fg('dim', truncateToWidth(`  (${this.selectedIndex + 1}/${count})`, width, '')));
      }
    }
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private itemCount(): number {
    return this.options.length + (this.allowComment ? 1 : 0) + (this.allowFreeform ? 1 : 0);
  }

  private isCommentRow(index: number): boolean {
    return this.allowComment && index === this.options.length;
  }

  private isFreeformRow(index: number): boolean {
    return this.allowFreeform && index === this.options.length + (this.allowComment ? 1 : 0);
  }

  private toggle(index: number): void {
    if (index < 0 || index >= this.options.length) return;
    if (this.checked.has(index)) this.checked.delete(index);
    else this.checked.add(index);
  }

  private toggleComment(): void {
    if (!this.allowComment) return;
    this.commentEnabled = !this.commentEnabled;
    this.invalidate();
  }
}

class SearchableSingleSelect implements Component {
  private selectedIndex = 0;
  private searchQuery = '';
  private commentEnabled = false;
  private maxVisibleRows = 12;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  onCancel?: () => void;
  onSubmit?: (selection: string, commentEnabled: boolean) => void;
  onEnterFreeform?: () => void;

  constructor(
    private readonly options: readonly AskUserOption[],
    private readonly allowFreeform: boolean,
    private readonly allowComment: boolean,
    private readonly theme: Theme,
    private readonly singleSelectLayout: AskUserSingleSelectLayout,
    private readonly keybindings: KeybindingsManager,
    private readonly commentToggle: ResolvedShortcut,
  ) {}

  setMaxVisibleRows(rows: number): void {
    const normalized = Math.max(1, Math.floor(rows));
    if (normalized !== this.maxVisibleRows) {
      this.maxVisibleRows = normalized;
      this.invalidate();
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    if (this.searchQuery && matchesKey(data, Key.escape)) {
      this.setSearch('');
      return;
    }
    if (this.keybindings.matches(data, 'tui.select.cancel')) return this.onCancel?.();
    if (this.allowComment && !this.commentToggle.disabled && this.commentToggle.matches(data)) {
      this.toggleComment();
      return;
    }
    const filtered = this.filtered();
    const count = this.itemCount(filtered);
    if (matchesUp(data, this.keybindings) && count > 0) {
      this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
      this.invalidate();
      return;
    }
    if (matchesDown(data, this.keybindings) && count > 0) {
      this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
      this.invalidate();
      return;
    }
    const number = data.match(/^[1-9]$/);
    if (number && Number(number[0]) <= filtered.length) {
      this.selectedIndex = Number(number[0]) - 1;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.space) && this.isCommentRow(this.selectedIndex, filtered)) {
      this.toggleComment();
      return;
    }
    if (matchesSubmit(data, this.keybindings) && count > 0) {
      if (this.isCommentRow(this.selectedIndex, filtered)) return this.toggleComment();
      if (this.isFreeformRow(this.selectedIndex, filtered)) return this.onEnterFreeform?.();
      const selected = filtered[this.selectedIndex]?.title;
      if (selected) this.onSubmit?.(selected, this.commentEnabled);
      else this.onCancel?.();
      return;
    }
    if (this.keybindings.matches(data, 'tui.editor.deleteCharBackward') || matchesKey(data, Key.backspace)) {
      const characters = [...this.searchQuery];
      characters.pop();
      this.setSearch(characters.join(''));
      return;
    }
    const printable = printableInput(data);
    if (printable) this.setSearch(this.searchQuery + printable);
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const filtered = this.filtered();
    const count = this.itemCount(filtered);
    this.selectedIndex = count > 0 ? Math.min(this.selectedIndex, count - 1) : 0;
    const split = this.singleSelectLayout === 'list' ? null : splitPaneWidths(width);
    const lines = split
      ? this.renderSplit(split.left, split.right, filtered)
      : this.renderList(width, filtered, false);
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private renderList(width: number, filtered: readonly AskUserOption[], hideDescriptions: boolean): string[] {
    const query = this.searchQuery ? this.theme.fg('text', this.searchQuery) : this.theme.fg('dim', 'type to filter');
    const header = [truncateToWidth(`${this.theme.fg('accent', 'Filter:')} ${query}`, width, '')];
    if (this.searchQuery && filtered.length === 0) header.push(this.theme.fg('warning', 'No matching options'));
    const rows = renderSingleSelectRows({
      options: filtered,
      selectedIndex: this.selectedIndex,
      width,
      allowFreeform: this.allowFreeform,
      allowComment: this.allowComment,
      commentEnabled: this.commentEnabled,
      maxRows: Math.max(1, this.maxVisibleRows - header.length),
      hideDescriptions,
    });
    const renderedRows = rows.map((row) => this.styleLine(row.line, width, row.selected));
    if (this.maxVisibleRows === 1) return renderedRows.length > 0 ? [renderedRows[0]!] : header.slice(-1);
    return [...header, ...renderedRows].slice(0, this.maxVisibleRows);
  }

  private renderSplit(leftWidth: number, rightWidth: number, filtered: readonly AskUserOption[]): string[] {
    const left = this.renderList(leftWidth, filtered, true);
    const right = this.preview(rightWidth, filtered);
    const rows = Math.min(this.maxVisibleRows, Math.max(left.length, right.length));
    return Array.from({ length: rows }, (_, index) => (
      `${truncateToWidth(left[index] ?? '', leftWidth, '', true)}${this.theme.fg('dim', SPLIT_SEPARATOR)}${truncateToWidth(right[index] ?? '', rightWidth, '')}`
    ));
  }

  private preview(width: number, filtered: readonly AskUserOption[]): string[] {
    let title: string;
    let description: string;
    if (this.isCommentRow(this.selectedIndex, filtered)) {
      title = 'Additional context';
      description = `Currently ${this.commentEnabled ? 'enabled' : 'disabled'}. Add an explanation after selecting.`;
    } else if (this.isFreeformRow(this.selectedIndex, filtered)) {
      title = 'Custom response';
      description = 'Open the editor to write an answer when none of the listed options fit.';
    } else {
      const selected = filtered[this.selectedIndex];
      title = selected?.title ?? 'No option selected';
      description = selected?.description ?? 'No additional details provided for this option.';
    }
    const lines = [this.theme.fg('accent', this.theme.bold(title)), ''];
    lines.push(...wrapTextWithAnsi(description, Math.max(10, width)).map((line) => this.theme.fg('muted', line)));
    return lines.slice(0, this.maxVisibleRows);
  }

  private styleLine(line: string, width: number, selected: boolean): string {
    if (selected) return truncateToWidth(this.theme.fg('accent', this.theme.bold(line)), width, '');
    if (line.startsWith('      ')) return truncateToWidth(this.theme.fg('muted', line), width, '');
    if (line.trim().startsWith('(')) return truncateToWidth(this.theme.fg('dim', line), width, '');
    return truncateToWidth(this.theme.fg('text', line), width, '');
  }

  private filtered(): AskUserOption[] {
    return fuzzyFilter([...this.options], this.searchQuery, (option) => `${option.title} ${option.description ?? ''}`);
  }

  private itemCount(filtered: readonly AskUserOption[]): number {
    return filtered.length + (this.allowComment ? 1 : 0) + (this.allowFreeform ? 1 : 0);
  }

  private isCommentRow(index: number, filtered: readonly AskUserOption[]): boolean {
    return this.allowComment && index === filtered.length;
  }

  private isFreeformRow(index: number, filtered: readonly AskUserOption[]): boolean {
    return this.allowFreeform && index === filtered.length + (this.allowComment ? 1 : 0);
  }

  private setSearch(value: string): void {
    this.searchQuery = value;
    this.selectedIndex = 0;
    this.invalidate();
  }

  private toggleComment(): void {
    this.commentEnabled = !this.commentEnabled;
    this.invalidate();
  }
}

function printableInput(data: string): string | null {
  const kitty = decodeKittyPrintable(data);
  if (kitty !== undefined) return kitty;
  const characters = [...data];
  if (characters.length !== 1) return null;
  const character = characters[0]!;
  const code = character.charCodeAt(0);
  return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f) ? null : character;
}

function splitPaneWidths(width: number): { left: number; right: number } | null {
  if (width < SPLIT_PANE_MIN_WIDTH) return null;
  const available = width - SPLIT_SEPARATOR.length;
  if (available < SPLIT_LEFT_MIN_WIDTH + SPLIT_RIGHT_MIN_WIDTH) return null;
  const left = Math.max(SPLIT_LEFT_MIN_WIDTH, Math.min(Math.floor(available * 0.42), available - SPLIT_RIGHT_MIN_WIDTH));
  const right = available - left;
  return right < SPLIT_RIGHT_MIN_WIDTH ? null : { left, right };
}

class AskPrompt extends Container {
  private mode: AskMode = 'select';
  private pendingSelections: string[] = [];
  private freeformDraft = '';
  private commentDraft = '';
  private readonly modeContainer = new Container();
  private readonly titleText = new Text('', 1, 0);
  private readonly helpText = new Text('', 1, 0);
  private readonly contextText?: Text;
  private contextIsCollapsible = false;
  private contextExpanded = false;
  private singleSelect?: SearchableSingleSelect;
  private multiSelect?: MultiSelectList;
  private editor?: Editor;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.editor && this.mode !== 'select') this.editor.focused = value;
  }

  constructor(
    private readonly question: AskUserQuestion,
    private readonly displayMode: 'overlay' | 'inline',
    private readonly singleSelectLayout: AskUserSingleSelectLayout,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly shortcuts: ResolvedShortcuts,
    private readonly onDone: Done,
  ) {
    super();
    this.addChild(new BorderTop(
      (text) => theme.fg('accent', text),
      'ask_user',
      (text) => theme.fg('dim', theme.bold(text)),
    ));
    this.addChild(new Spacer(1));
    this.addChild(this.titleText);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg('text', theme.bold(question.question)), 1, 0));
    if (question.context) {
      this.addChild(new Spacer(1));
      this.contextText = new Text('', 1, 0);
      this.addChild(this.contextText);
    }
    this.addChild(new Spacer(1));
    this.addChild(this.modeContainer);
    this.addChild(new Spacer(1));
    this.addChild(this.helpText);
    this.addChild(new Spacer(1));
    this.addChild(new BorderBottom(
      (text) => theme.fg('accent', text),
      `v${VERSION}`,
      (text) => theme.fg('dim', text),
    ));
    this.showSelect();
  }

  override invalidate(): void {
    super.invalidate();
    this.updateText();
  }

  override render(width: number): string[] {
    const innerWidth = Math.max(1, width - BOX_OVERHEAD);
    const maxHeight = this.displayMode === 'overlay'
      ? overlayMaxRenderLines(this.tui.terminal.rows)
      : undefined;
    this.updateContext(innerWidth, maxHeight);
    if (this.mode === 'select') {
      const questionRows = wrapTextWithAnsi(this.question.question, Math.max(10, innerWidth - 2)).length;
      const contextRows = this.contextText?.render(innerWidth).length ?? 0;
      const staticLines = 10 + questionRows + (contextRows > 0 ? contextRows + 1 : 0);
      const visibleRows = maxHeight === undefined
        ? (this.question.allowMultiple ? 10 : 12)
        : Math.max(1, maxHeight - staticLines);
      if (this.question.allowMultiple) this.ensureMulti().setMaxVisibleRows(visibleRows);
      else this.ensureSingle().setMaxVisibleRows(visibleRows);
    }
    const lines = super.render(innerWidth);
    if (maxHeight !== undefined && lines.length > maxHeight) {
      if (maxHeight <= 1) return [this.renderTopBorder(width)];
      if (maxHeight === 2) return [this.renderTopBorder(width), this.renderBottomBorder(width)];
      const bodyCapacity = maxHeight - 2;
      const renderedModeLines = this.modeContainer.render(innerWidth);
      let prioritizedModeLines = renderedModeLines;
      if (this.mode !== 'select' && renderedModeLines.length > 1) {
        prioritizedModeLines = renderedModeLines.slice(0, -1);
      } else if (!this.question.allowMultiple && renderedModeLines.length > 1) {
        prioritizedModeLines = renderedModeLines.slice(1);
      }
      const modeLines = prioritizedModeLines.slice(-bodyCapacity);
      const promptBudget = Math.max(0, bodyCapacity - modeLines.length);
      const promptLines = [
        ...new Text(this.theme.fg('text', this.theme.bold(this.question.question)), 1, 0).render(innerWidth),
        ...(this.contextText?.render(innerWidth) ?? []),
      ].slice(0, promptBudget);
      return this.frameBody([...promptLines, ...modeLines], width, innerWidth);
    }
    const border = (text: string) => this.theme.fg('accent', text);
    return lines.map((line, index) => {
      if (index === 0) return this.renderTopBorder(width);
      if (index === lines.length - 1) return this.renderBottomBorder(width);
      return `${border(BOX_LEFT)}${truncateToWidth(line, innerWidth, '', true)}${border(BOX_RIGHT)}`;
    });
  }

  handleInput(data: string): void {
    if (this.contextIsCollapsible && matchesKey(data, CONTEXT_TOGGLE_KEY)) {
      this.contextExpanded = !this.contextExpanded;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (this.mode !== 'select') {
      if (matchesKey(data, Key.escape)) {
        this.showSelect();
        return;
      }
      if (this.keybindings.matches(data, 'tui.select.cancel')) {
        this.onDone(null);
        return;
      }
      this.ensureEditor().handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (this.question.allowMultiple) this.ensureMulti().handleInput(data);
    else this.ensureSingle().handleInput(data);
    this.tui.requestRender();
  }

  isTextInputMode(): boolean {
    return this.mode !== 'select';
  }

  private ensureSingle(): SearchableSingleSelect {
    if (this.singleSelect) return this.singleSelect;
    const list = new SearchableSingleSelect(
      this.question.options,
      this.question.allowFreeform,
      this.question.allowComment,
      this.theme,
      this.singleSelectLayout,
      this.keybindings,
      this.shortcuts.commentToggle,
    );
    list.onCancel = () => this.onDone(null);
    list.onEnterFreeform = () => this.showFreeform();
    list.onSubmit = (selection, comment) => this.handleSelection([selection], comment);
    this.singleSelect = list;
    return list;
  }

  private ensureMulti(): MultiSelectList {
    if (this.multiSelect) return this.multiSelect;
    const list = new MultiSelectList(
      this.question.options,
      this.question.allowFreeform,
      this.question.allowComment,
      this.theme,
      this.keybindings,
      this.shortcuts.commentToggle,
    );
    list.onCancel = () => this.onDone(null);
    list.onEnterFreeform = () => this.showFreeform();
    list.onSubmit = (selections, comment) => this.handleSelection(selections, comment);
    this.multiSelect = list;
    return list;
  }

  private ensureEditor(): Editor {
    if (this.editor) return this.editor;
    const editor = new Editor(this.tui, createEditorTheme(this.theme));
    editor.disableSubmit = false;
    editor.onSubmit = (text) => {
      if (this.mode === 'freeform') this.onDone(freeformResponse(text));
      else this.onDone(selectionResponse(this.pendingSelections, text));
    };
    editor.focused = this._focused;
    this.editor = editor;
    return editor;
  }

  private handleSelection(selections: string[], wantsComment: boolean): void {
    if (this.question.allowComment && wantsComment) {
      this.pendingSelections = selections;
      this.commentDraft = '';
      this.showComment();
      return;
    }
    this.onDone(selectionResponse(selections));
  }

  private showSelect(): void {
    this.saveDraft();
    this.mode = 'select';
    this.pendingSelections = [];
    this.modeContainer.clear();
    this.modeContainer.addChild(this.question.allowMultiple ? this.ensureMulti() : this.ensureSingle());
    this.updateText();
    this.invalidate();
    this.tui.requestRender();
  }

  private showFreeform(): void {
    this.saveDraft();
    this.mode = 'freeform';
    this.modeContainer.clear();
    this.setEditorText(this.freeformDraft);
    this.modeContainer.addChild(new Text(this.theme.fg('accent', this.theme.bold('Custom response')), 1, 0));
    this.modeContainer.addChild(new Spacer(1));
    this.modeContainer.addChild(this.ensureEditor());
    this.updateText();
    this.invalidate();
    this.tui.requestRender();
  }

  private showComment(): void {
    this.saveDraft();
    this.mode = 'comment';
    this.modeContainer.clear();
    this.setEditorText(this.commentDraft);
    this.modeContainer.addChild(new Text(this.theme.fg('accent', this.theme.bold('Selected:')), 1, 0));
    this.modeContainer.addChild(new Text(this.pendingSelections.join(', '), 1, 0));
    this.modeContainer.addChild(new Spacer(1));
    this.modeContainer.addChild(this.ensureEditor());
    this.updateText();
    this.invalidate();
    this.tui.requestRender();
  }

  private saveDraft(): void {
    if (!this.editor || this.mode === 'select') return;
    const text = this.editor.getText();
    if (this.mode === 'freeform') this.freeformDraft = text;
    else this.commentDraft = text;
  }

  private setEditorText(text: string): void {
    this.ensureEditor().setText(text);
  }

  private updateText(): void {
    this.titleText.setText(this.theme.fg('accent', this.theme.bold(this.mode === 'comment' ? 'Optional comment' : 'Question')));
    const overlay = this.displayMode === 'overlay' && !this.shortcuts.overlayToggle.disabled
      ? literalHint(this.theme, this.shortcuts.overlayToggle.spec, 'hide')
      : undefined;
    const context = this.contextIsCollapsible
      ? literalHint(this.theme, CONTEXT_TOGGLE_KEY, this.contextExpanded ? 'collapse context' : 'expand context')
      : undefined;
    if (this.mode !== 'select') {
      this.helpText.setText(this.theme.fg('dim', [
        keyHint(this.theme, this.keybindings, 'tui.input.submit', this.mode === 'comment' ? 'submit/skip' : 'submit'),
        literalHint(this.theme, 'esc', 'back'),
        context,
        overlay,
      ].filter(Boolean).join(' • ')));
      return;
    }
    const comment = this.question.allowComment && !this.shortcuts.commentToggle.disabled
      ? literalHint(this.theme, this.shortcuts.commentToggle.spec, 'toggle context')
      : undefined;
    this.helpText.setText(this.theme.fg('dim', [
      this.question.allowMultiple ? literalHint(this.theme, 'space', 'toggle') : literalHint(this.theme, 'type', 'filter'),
      literalHint(this.theme, '↑↓', 'navigate'),
      comment,
      context,
      overlay,
      keyHint(this.theme, this.keybindings, 'tui.select.confirm', this.question.allowMultiple ? 'submit' : 'select'),
      keyHint(this.theme, this.keybindings, 'tui.select.cancel', 'cancel'),
    ].filter(Boolean).join(' • ')));
  }

  private updateContext(width: number, maxHeight: number | undefined): void {
    if (!this.contextText || !this.question.context) return;
    const contentWidth = Math.max(10, width - 2);
    const contextRows = wrapTextWithAnsi(this.question.context, contentWidth).length;
    const questionRows = wrapTextWithAnsi(this.question.question, contentWidth).length;
    const wouldCrowdChoices = maxHeight !== undefined && 11 + questionRows + contextRows + 1 > maxHeight;
    const collapsible = contextRows > INLINE_CONTEXT_MAX_ROWS || wouldCrowdChoices;
    if (this.contextIsCollapsible !== collapsible) {
      this.contextIsCollapsible = collapsible;
      if (!collapsible) this.contextExpanded = false;
      this.updateText();
    }
    if (this.contextIsCollapsible && !this.contextExpanded) {
      this.contextText.setText(this.theme.fg(
        'dim',
        `Context (${contextRows} lines) — ${CONTEXT_TOGGLE_KEY} expand`,
      ));
      return;
    }
    this.contextText.setText(
      `${this.theme.fg('accent', this.theme.bold('Context:'))}\n${this.theme.fg('dim', this.question.context)}`,
    );
  }

  private frameBody(body: string[], width: number, innerWidth: number): string[] {
    const border = (text: string) => this.theme.fg('accent', text);
    return [
      this.renderTopBorder(width),
      ...body.map((line) => `${border(BOX_LEFT)}${truncateToWidth(line, innerWidth, '', true)}${border(BOX_RIGHT)}`),
      this.renderBottomBorder(width),
    ];
  }

  private renderTopBorder(width: number): string {
    return new BorderTop(
      (text) => this.theme.fg('accent', text),
      'ask_user',
      (text) => this.theme.fg('dim', this.theme.bold(text)),
    ).render(width)[0]!;
  }

  private renderBottomBorder(width: number): string {
    return new BorderBottom(
      (text) => this.theme.fg('accent', text),
      `v${VERSION}`,
      (text) => this.theme.fg('dim', text),
    ).render(width)[0]!;
  }
}

class AskWizard implements Component {
  private index = 0;
  private readonly responses = new Map<string, AskUserResponse>();
  private prompt: AskPrompt | undefined;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.prompt) this.prompt.focused = value;
  }

  constructor(
    private readonly questions: readonly AskUserQuestion[],
    private readonly displayMode: 'overlay' | 'inline',
    private readonly singleSelectLayout: AskUserSingleSelectLayout,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly shortcuts: ResolvedShortcuts,
    private readonly reportProgress: (answers: readonly AskUserQuestionAnswer[]) => void,
    private readonly onDone: (answers: readonly AskUserQuestionAnswer[] | null) => void,
  ) {}

  invalidate(): void {
    this.prompt?.invalidate();
  }

  handleInput(data: string): void {
    if (this.index === this.questions.length) {
      if (this.navigate(data)) return;
      if (matchesSubmit(data, this.keybindings)) {
        const answers = this.answers();
        this.onDone(answers.some((answer) => answer.response !== null) ? answers : null);
      } else if (this.keybindings.matches(data, 'tui.select.cancel')) {
        this.onDone(null);
      }
      return;
    }
    const prompt = this.ensurePrompt();
    if (!prompt.isTextInputMode() && this.navigate(data)) return;
    prompt.handleInput(data);
  }

  render(width: number): string[] {
    const body = this.index === this.questions.length ? this.renderReview(width) : this.ensurePrompt().render(width);
    if (body.length < 2) return body;
    const border = (text: string) => this.theme.fg('accent', text);
    const inner = Math.max(1, width - BOX_OVERHEAD);
    const navigation = `${border(BOX_LEFT)}${truncateToWidth(this.navigation(), inner, '', true)}${border(BOX_RIGHT)}`;
    const spacer = `${border(BOX_LEFT)}${truncateToWidth('', inner, '', true)}${border(BOX_RIGHT)}`;
    const decorated = [body[0]!, navigation, spacer, ...body.slice(1)];
    if (this.displayMode !== 'overlay') return decorated;
    const maxHeight = overlayMaxRenderLines(this.tui.terminal.rows);
    if (decorated.length <= maxHeight) return decorated;
    if (maxHeight <= 1) return [body[0]!];
    if (maxHeight === 2) return [body[0]!, body.at(-1)!];
    const contentCapacity = maxHeight - 2;
    const promptContent = body.slice(1, -1);
    const content = contentCapacity === 1
      ? promptContent.slice(-1)
      : [navigation, ...promptContent.slice(-(contentCapacity - 1))];
    return [body[0]!, ...content, body.at(-1)!];
  }

  private ensurePrompt(): AskPrompt {
    if (this.prompt) return this.prompt;
    const question = this.questions[this.index]!;
    this.prompt = new AskPrompt(
      question,
      this.displayMode,
      this.singleSelectLayout,
      this.tui,
      this.theme,
      this.keybindings,
      this.shortcuts,
      (response) => {
        if (response === null) {
          this.onDone(null);
          return;
        }
        this.responses.set(question.id, response);
        const answers = this.answers();
        this.reportProgress(answers);
        this.index = this.index < this.questions.length - 1 ? this.index + 1 : this.questions.length;
        this.prompt = undefined;
        this.invalidate();
        this.tui.requestRender();
      },
    );
    this.prompt.focused = this._focused;
    return this.prompt;
  }

  private navigate(data: string): boolean {
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      this.goTo((this.index + 1) % (this.questions.length + 1));
      return true;
    }
    if (matchesKey(data, Key.shift('tab')) || matchesKey(data, Key.left)) {
      this.goTo((this.index - 1 + this.questions.length + 1) % (this.questions.length + 1));
      return true;
    }
    return false;
  }

  private goTo(index: number): void {
    this.index = index;
    this.prompt = undefined;
    this.invalidate();
    this.tui.requestRender();
  }

  private answers(): AskUserQuestionAnswer[] {
    return this.questions.map((question) => ({
      questionId: question.id,
      response: this.responses.get(question.id) ?? null,
    }));
  }

  private navigation(): string {
    const parts = [this.theme.fg('dim', '←')];
    for (let index = 0; index < this.questions.length; index += 1) {
      const question = this.questions[index]!;
      const answered = this.responses.has(question.id);
      const label = `${answered ? '✓' : '□'} ${question.header}`;
      parts.push(index === this.index
        ? this.theme.fg('accent', `[${label}]`)
        : this.theme.fg(answered ? 'success' : 'muted', label));
    }
    const submit = `${this.responses.size > 0 ? '✓' : '□'} Submit`;
    parts.push(this.index === this.questions.length
      ? this.theme.fg('accent', `[${submit}]`)
      : this.theme.fg(this.responses.size > 0 ? 'success' : 'muted', submit));
    parts.push(this.theme.fg('dim', '→'));
    return parts.join(' ');
  }

  private renderReview(width: number): string[] {
    const border = (text: string) => this.theme.fg('accent', text);
    const inner = Math.max(1, width - BOX_OVERHEAD);
    const body = [this.theme.fg('accent', this.theme.bold('Review answers')), ''];
    for (const question of this.questions) {
      body.push(`${this.theme.fg('muted', `${question.header}:`)} ${this.theme.fg('text', question.question)}`);
      body.push(`  ${this.responses.has(question.id) ? formatResponse(this.responses.get(question.id)!) : this.theme.fg('muted', 'Skipped')}`);
    }
    body.push('', this.theme.fg('dim', 'Enter submit • unanswered questions are skipped • Tab/←→ navigate • Esc cancel'));
    return [
      new BorderTop(border, 'ask_user', (text) => this.theme.fg('dim', this.theme.bold(text))).render(width)[0]!,
      ...body.map((line) => `${border(BOX_LEFT)}${truncateToWidth(line, inner, '', true)}${border(BOX_RIGHT)}`),
      new BorderBottom(border, `v${VERSION}`, (text) => this.theme.fg('dim', text)).render(width)[0]!,
    ];
  }
}

async function askQuestionsViaDialogs(
  ui: ExtensionContext['ui'],
  questions: readonly AskUserQuestion[],
  timeout?: number,
  signal?: AbortSignal,
): Promise<{
  readonly answers: AskUserQuestionAnswer[];
  readonly cancelled?: 'timeout' | 'abort';
}> {
  const answers: AskUserQuestionAnswer[] = [];
  const deadline = timeout === undefined ? undefined : Date.now() + timeout;
  for (const question of questions) {
    if (signal?.aborted) return { answers, cancelled: 'abort' };
    const remaining = deadline === undefined ? undefined : deadline - Date.now();
    if (remaining !== undefined && remaining <= 0) return { answers, cancelled: 'timeout' };
    const response = await raceDialogAbort(
      askViaDialogs(ui, question, remaining),
      signal,
    );
    if (response.aborted) return { answers, cancelled: 'abort' };
    if (response.value === null && deadline !== undefined && Date.now() >= deadline) {
      return { answers, cancelled: 'timeout' };
    }
    answers.push({
      questionId: question.id,
      response: response.value,
    });
  }
  return { answers };
}

async function raceDialogAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<{ readonly aborted: false; readonly value: T } | { readonly aborted: true }> {
  if (!signal) return { aborted: false, value: await operation };
  if (signal.aborted) return { aborted: true };
  // Pi dialogs have no abort option, so stop this host flow even if the RPC
  // client dismisses its outstanding prompt later.
  let removeListener = () => {};
  const aborted = new Promise<{ readonly aborted: true }>((resolve) => {
    const onAbort = () => resolve({ aborted: true });
    signal.addEventListener('abort', onAbort, { once: true });
    removeListener = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([
      operation.then((value) => ({ aborted: false as const, value })),
      aborted,
    ]);
  } finally {
    removeListener();
  }
}

async function askViaDialogs(
  ui: ExtensionContext['ui'],
  question: AskUserQuestion,
  timeout?: number,
): Promise<AskUserResponse | null> {
  const dialogOptions = timeout === undefined ? undefined : { timeout };
  const prompt = question.context
    ? `${question.question}\n\nContext:\n${question.context}`
    : question.question;
  if (question.options.length === 0) {
    const answer = await ui.input(prompt, 'Type your answer...', dialogOptions);
    return answer === undefined ? null : freeformResponse(answer);
  }
  if (question.allowMultiple) {
    const options = formatOptions(question.options);
    const raw = await ui.input(
      `${prompt}\n\nOptions (select one or more):\n${options}`,
      'Type option titles separated by commas...',
      dialogOptions,
    );
    if (raw === undefined) return null;
    const selections = raw.split(',').map((selection) => selection.trim()).filter(Boolean);
    if (selections.length === 0) return null;
    if (!question.allowComment) return selectionResponse(selections);
    const comment = await ui.input(
      `${prompt}\n\nSelected:\n${selections.map((selection) => `- ${selection}`).join('\n')}`,
      'Optional comment (press Enter to skip)...',
      dialogOptions,
    );
    return selectionResponse(selections, comment);
  }
  const options = question.options.map((option) => option.title);
  if (question.allowFreeform) options.push(FREEFORM_SENTINEL);
  const selected = await ui.select(prompt, options, dialogOptions);
  if (selected === undefined) return null;
  if (selected === FREEFORM_SENTINEL) {
    const answer = await ui.input(prompt, 'Type your answer...', dialogOptions);
    return answer === undefined ? null : freeformResponse(answer);
  }
  if (!question.allowComment) return selectionResponse([selected]);
  const comment = await ui.input(
    `${prompt}\n\nSelected option:\n- ${selected}`,
    'Optional comment (press Enter to skip)...',
    dialogOptions,
  );
  return selectionResponse([selected], comment);
}

function selectionResponse(selections: readonly string[], comment?: string): AskUserResponse | null {
  const normalizedSelections = selections.map((selection) => selection.trim()).filter(Boolean);
  if (normalizedSelections.length === 0) return null;
  const normalizedComment = comment?.trim();
  return {
    kind: 'selection',
    selections: normalizedSelections,
    ...(normalizedComment ? { comment: normalizedComment } : {}),
  };
}

function freeformResponse(text: string): AskUserResponse | null {
  const normalized = text.trim();
  return normalized ? { kind: 'freeform', text: normalized } : null;
}

function formatOptions(options: readonly AskUserOption[]): string {
  return options.map((option, index) => (
    `${index + 1}. ${option.title}${option.description ? ` — ${option.description}` : ''}`
  )).join('\n');
}

function formatResponse(response: AskUserResponse): string {
  if (response.kind === 'freeform') return response.text;
  const selections = response.selections.join(', ');
  return response.comment ? `${selections} — ${response.comment}` : selections;
}

const toolPresentation: AskUserToolPresentation = {
  renderCall(args, theme) {
    const values = args as Record<string, unknown>;
    if (Array.isArray(values.questions) && values.questions.length > 0) {
      const labels = values.questions.map((question: { header?: string; question?: string }, index: number) => (
        question.header || question.question || `Q${index + 1}`
      ));
      return new Text(
        `${theme.fg('toolTitle', theme.bold('ask_user '))}${theme.fg('muted', `${values.questions.length} questions`)}\n${theme.fg('dim', `  ${truncateToWidth(labels.join(', '), 80)}`)}`,
        0,
        0,
      );
    }
    const options = Array.isArray(values.options) ? values.options : [];
    const labels = options.map((option: unknown) => normalizeAskUserOption(option)?.title ?? '<invalid>');
    const optionLine = labels.length > 0
      ? `\n${theme.fg('dim', `  ${labels.length} option(s): ${labels.join(', ')}`)}`
      : '';
    const modes = `${values.allowMultiple ? ' [multi-select]' : ''}${values.allowComment ? ' [optional comment]' : ''}`;
    return new Text(
      `${theme.fg('toolTitle', theme.bold('ask_user '))}${theme.fg('muted', String(values.question ?? ''))}${optionLine}${theme.fg('dim', modes)}`,
      0,
      0,
    );
  },
  renderResult(result, options, theme) {
    const details = result.details as AskUserToolDetails | AskUserToolErrorDetails | undefined;
    if (details && 'error' in details) return new Text(theme.fg('error', `✗ ${details.error}`), 0, 0);
    if (options.isPartial) {
      const waiting = result.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n') || 'Waiting for user input...';
      return new Text(theme.fg('muted', waiting), 0, 0);
    }
    if (!details) return new Text(theme.fg('warning', 'No result'), 0, 0);
    if (details.status === 'cancelled') return new Text(theme.fg('warning', details.message ?? 'Cancelled'), 0, 0);
    if (details.status === 'deferred') {
      const interaction = details.interactionId ? ` (interaction: ${details.interactionId})` : '';
      return new Text(theme.fg('muted', `${details.message ?? 'Question sent'}${interaction}`), 0, 0);
    }
    if (details.status === 'pending') return new Text(theme.fg('muted', 'Waiting for user input...'), 0, 0);
    if (details.kind === 'single') {
      if (!details.response) return new Text(theme.fg('warning', 'Skipped'), 0, 0);
      let text = `${theme.fg('success', '✓ ')}${theme.fg('accent', formatResponse(details.response))}`;
      if (options.expanded) {
        text += `\n${theme.fg('dim', `Q: ${details.question.question}`)}`;
        if (details.question.context) text += `\n${theme.fg('dim', details.question.context)}`;
      }
      return new Text(text, 0, 0);
    }
    const lines = details.questions.map((question) => {
      const response = details.responses[question.id];
      return response
        ? `${theme.fg('success', '✓ ')}${theme.fg('accent', question.header)}: ${formatResponse(response)}`
        : `${theme.fg('muted', '○ ')}${theme.fg('muted', question.header)}: skipped`;
    });
    return new Text(lines.join('\n'), 0, 0);
  },
};
