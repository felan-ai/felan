import type {
  ExtensionContext,
  FelanExtensionAPI,
} from '@felan-ai/agent-core';
import {
  CustomEditor,
  type KeybindingsManager,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  Input,
  Key,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type Focusable,
  type OverlayOptions,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';
import { AgentTranscript, type AgentToolPresentation } from './agent-transcript.js';
import { registerSubagentCompletionRenderer } from './completion-presentation.js';
import type { LocalSubagentView } from './types.js';
import type { AgentViewTranscript } from './types.js';
import type { LocalSubagentNavigatorHost, LocalSubagentNavigatorOptions, LocalSubagentPresentationHost } from './types.js';
export type { AgentRailRenderer, LocalSubagentNavigatorHost, LocalSubagentNavigatorOptions } from './types.js';

export interface AgentNavigatorRecord extends LocalSubagentView {
  readonly projection?: AgentViewTranscript;
  readonly activity?: string;
  readonly transcriptStatus?: string;
}
export interface AgentNavigatorHost extends Pick<LocalSubagentNavigatorHost, 'cancel' | 'steer'> {
  listLocalSubagents(): readonly AgentNavigatorRecord[];
  getLocalSubagent(id: string): AgentNavigatorRecord | undefined;
  selectAgent?(id: string | undefined): void;
  subscribe?(listener: () => void): () => void;
  getStatus?(): string | undefined;
  toolPresentation?(name: string): AgentToolPresentation | undefined;
}

const MAX_RAIL_ROWS = 5;
const REFRESH_INTERVAL_MS = 1_000;
const ACTIVE_RAIL_REFRESH_INTERVAL_MS = 250;

export const AGENT_NAVIGATOR_SHORTCUT = Key.alt('a');
export const AGENT_NAVIGATOR_OVERLAY_OPTIONS: OverlayOptions = {
  anchor: 'top-left',
  width: '100%',
  maxHeight: '100%',
  margin: 0,
};

export function createLocalSubagentPresentation(): LocalSubagentPresentationHost {
  return { register: registerLocalSubagentNavigator };
}

export class AgentRailEditor extends CustomEditor {
  #railFocused = false;
  #selectedAgentId: string | undefined;
  #selectedIndex = 0;

  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    private readonly appKeybindings: KeybindingsManager,
    private readonly host: Pick<AgentNavigatorHost, 'listLocalSubagents'>,
    private readonly themeProvider: () => Theme,
    private readonly openAgent: (agentId: string) => void,
    private readonly renderRailInEditor: () => boolean = () => true,
  ) {
    super(tui, editorTheme, appKeybindings);
  }

  isRailFocused(): boolean { return this.#railFocused; }

  handleInput(data: string): void {
    const records = activeSubagents(this.host);
    this.#syncSelection(records);

    if (this.#railFocused) {
      if (this.appKeybindings.matches(data, 'tui.editor.cursorUp')) {
        if (this.#selectedIndex === 0) this.#railFocused = false;
        else this.#select(records, this.#selectedIndex - 1);
        this.tui.requestRender();
        return;
      }
      if (this.appKeybindings.matches(data, 'tui.editor.cursorDown')) {
        this.#select(records, Math.min(records.length - 1, this.#selectedIndex + 1));
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const selected = records[this.#selectedIndex];
        if (selected) this.openAgent(selected.id);
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.#railFocused = false;
        this.tui.requestRender();
        return;
      }
      this.#railFocused = false;
    }

    if (
      records.length > 0
      && !this.isShowingAutocomplete()
      && this.appKeybindings.matches(data, 'tui.editor.cursorDown')
    ) {
      const beforeText = this.getText();
      const beforeCursor = this.getCursor();
      super.handleInput(data);
      const afterCursor = this.getCursor();
      if (
        this.getText() === beforeText
        && afterCursor.line === beforeCursor.line
        && afterCursor.col === beforeCursor.col
      ) {
        this.#railFocused = true;
        this.#select(records, 0);
        this.tui.requestRender();
      }
      return;
    }

    super.handleInput(data);
  }

  render(width: number): string[] {
    const records = activeSubagents(this.host);
    this.#syncSelection(records);
    const wasFocused = this.focused;
    if (this.#railFocused) this.focused = false;
    let editorLines: string[];
    try {
      editorLines = super.render(width);
    } finally {
      this.focused = wasFocused;
    }
    if (this.#railFocused) hideEditorCursor(editorLines);
    return this.renderRailInEditor()
      ? [...editorLines, ...this.renderRail(width)]
      : editorLines;
  }

  renderRail(width: number): string[] {
    if (width <= 0) return [];
    const records = activeSubagents(this.host);
    this.#syncSelection(records);
    const theme = this.themeProvider();
    return records.map((record, index) => renderAgentRow(
      record,
      this.#railFocused && index === this.#selectedIndex,
      theme,
      width,
    ));
  }

  refresh(): void {
    this.#syncSelection(activeSubagents(this.host));
    this.tui.requestRender();
  }

  #syncSelection(records: readonly LocalSubagentView[]): void {
    if (records.length === 0) {
      this.#railFocused = false;
      this.#selectedAgentId = undefined;
      this.#selectedIndex = 0;
      return;
    }
    const selectedIndex = records.findIndex((record) => record.id === this.#selectedAgentId);
    this.#select(records, selectedIndex < 0 ? Math.min(this.#selectedIndex, records.length - 1) : selectedIndex);
  }

  #select(records: readonly LocalSubagentView[], index: number): void {
    this.#selectedIndex = Math.max(0, Math.min(records.length - 1, index));
    this.#selectedAgentId = records[this.#selectedIndex]?.id;
  }
}

export class AgentNavigator implements Component, Focusable {
  readonly #input = new Input();
  #records: AgentNavigatorRecord[] = [];
  #selectedId: string | undefined;
  #transcript: AgentTranscript | undefined;
  #transcriptSession: LocalSubagentView['liveSession'];
  #transcriptProjection: AgentViewTranscript | undefined;
  #transcriptAgent: string | undefined;
  #unsubscribe: (() => void) | undefined;
  #refreshInterval: ReturnType<typeof setInterval> | undefined;
  #inputFocused = false;
  #closed = false;
  #statusMessage = '';
  #scrollOffset = 0;
  #autoScroll = true;
  #lastContentLength = 0;
  #lastViewportHeight = 1;
  #focused = false;
  #controlPending = false;

  constructor(
    private readonly tui: TUI,
    private readonly host: AgentNavigatorHost,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: () => void,
    initialAgentId?: string,
  ) {
    this.#records = [...host.listLocalSubagents()];
    this.#selectedId = initialAgentId && this.#records.some((record) => record.id === initialAgentId)
      ? initialAgentId
      : this.#initialSelection(this.#records);
    this.#input.onSubmit = (value) => {
      void this.#submitSteer(value);
    };
    this.#input.onEscape = () => this.close();
    this.#syncSelectedRecord();
    this.#refreshInterval = setInterval(() => {
      if (this.#closed) return;
      this.#refreshRecords();
      this.tui.requestRender();
    }, REFRESH_INTERVAL_MS);
    this.#refreshInterval.unref?.();
    this.#unsubscribe = host.subscribe?.(() => {
      if (this.#closed) return;
      this.#refreshRecords();
      this.tui.requestRender();
    });
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    this.#input.focused = value && this.#inputFocused;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.done();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.close();
      return;
    }

    if (this.#inputFocused) {
      if (matchesKey(data, Key.tab)) this.#focusNavigation();
      else this.#input.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (this.#transcript?.handleInput(data)) return;
    if (matchesKey(data, Key.up) || matchesKey(data, 'k')) {
      this.#moveSelection(-1);
    } else if (matchesKey(data, Key.down) || matchesKey(data, 'j')) {
      this.#moveSelection(1);
    } else if (matchesKey(data, Key.pageUp)) {
      this.#scrollBy(-this.#lastViewportHeight);
    } else if (matchesKey(data, Key.pageDown)) {
      this.#scrollBy(this.#lastViewportHeight);
    } else if (matchesKey(data, Key.home)) {
      this.#autoScroll = false;
      this.#scrollOffset = 0;
    } else if (matchesKey(data, Key.end)) {
      this.#autoScroll = true;
    } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.tab)) {
      this.#focusInput();
    } else if (matchesKey(data, 'q')) {
      this.close();
    } else if (matchesKey(data, 'x') || matchesKey(data, 's')) {
      void this.#stopSelected();
    } else {
      return;
    }
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.#closed || event.type !== 'wheel') return undefined;
    this.#scrollBy(Math.sign(event.wheelDelta ?? 0));
    return { handled: true };
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    this.#refreshRecords();

    const renderWidth = Math.max(1, Math.floor(width));
    const contentWidth = Math.max(1, renderWidth - 2);
    const rows = Math.max(1, this.tui.terminal.rows - 2);
    if (this.#inputFocused && rows < 5) this.#focusNavigation(true);
    const selected = this.#selectedRecord();
    const canSteer = selected?.state === 'running';
    const status = this.#statusMessage || this.host.getStatus?.();
    const showStatus = Boolean(status) && rows >= 7;
    const showPrompt = canSteer && rows >= 5;
    const showDivider = rows >= 6;
    const showHints = rows >= 4;
    const fixedRows = 1
      + Number(showStatus)
      + Number(showPrompt)
      + Number(showDivider)
      + Number(showHints);
    const contentBudget = Math.max(0, rows - fixedRows);
    let railRows = contentBudget > 1
      ? Math.min(MAX_RAIL_ROWS, this.#records.length, Math.max(1, contentBudget - 1))
      : 0;
    let viewportHeight = contentBudget - railRows;
    if (viewportHeight < 1 && railRows > 0 && contentBudget > 1) {
      railRows -= 1;
      viewportHeight = 1;
    }
    this.#lastViewportHeight = Math.max(1, viewportHeight);

    const lines: string[] = [this.#renderHeader(selected)];
    if (showStatus) lines.push(this.theme.fg('warning', activityLine(status!)));
    lines.push(...this.#renderTranscript(contentWidth, viewportHeight, selected));
    if (showDivider) lines.push(this.theme.fg('border', '─'.repeat(contentWidth)));
    if (showPrompt && selected) lines.push(this.#renderInput(contentWidth, selected));
    lines.push(...this.#renderRail(contentWidth, railRows));
    if (showHints) lines.push(this.#renderHints());

    while (lines.length < rows) {
      lines.splice(Math.max(1, lines.length - railRows - Number(showHints)), 0, '');
    }
    return frameOverlayLines(lines.slice(0, rows).map((line) => this.#fitLine(line, contentWidth)), renderWidth, this.theme);
  }

  invalidate(): void {
    this.#transcript?.invalidate();
  }

  dispose(): void {
    this.#closed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#refreshInterval) {
      clearInterval(this.#refreshInterval);
      this.#refreshInterval = undefined;
    }
    this.#focusNavigation(true);
    this.#transcript?.dispose();
    this.#transcript = undefined;
    this.#transcriptSession = undefined;
    this.#transcriptProjection = undefined;
    const selected = this.#transcriptAgent;
    this.#transcriptAgent = undefined;
    if (selected !== undefined) this.host.selectAgent?.(undefined);
  }

  #initialSelection(records: readonly LocalSubagentView[]): string | undefined {
    return records.find((record) => record.state === 'running' || record.state === 'queued')?.id
      ?? records[0]?.id;
  }

  #refreshRecords(): void {
    const previousIndex = Math.max(
      0,
      this.#records.findIndex((record) => record.id === this.#selectedId),
    );
    this.#records = [...this.host.listLocalSubagents()];

    if (this.#selectedId && !this.#records.some((record) => record.id === this.#selectedId)) {
      if (this.#inputFocused) this.#focusNavigation(true);
      this.#selectedId = this.#records[Math.min(previousIndex, this.#records.length - 1)]?.id;
      this.#statusMessage = '';
    } else if (!this.#selectedId && this.#records.length > 0) {
      this.#selectedId = this.#initialSelection(this.#records);
    }

    const selected = this.#selectedRecord();
    if (this.#inputFocused && selected?.state !== 'running') this.#focusNavigation(true);
    this.#syncSelectedRecord();
  }

  #syncSelectedRecord(): void {
    const record = this.#selectedRecord();
    const session = record?.liveSession;
    const projection = record?.projection;
    const selectedChanged = record?.id !== this.#transcriptAgent;
    if (selectedChanged || session !== this.#transcriptSession) {
      this.#transcript?.dispose();
      this.#transcript = undefined;
      this.#transcriptProjection = undefined;
      this.#scrollOffset = 0;
      this.#autoScroll = true;
    }
    const changed = selectedChanged || session !== this.#transcriptSession || projection !== this.#transcriptProjection;
    this.#transcriptSession = session;
    this.#transcriptProjection = projection;
    this.#transcriptAgent = record?.id;
    if (!changed) return;
    if (!session && !projection) {
      this.#transcript?.dispose();
      this.#transcript = undefined;
    } else {
      try {
        if (projection && projection.agentId !== record?.id) throw new Error('Transcript identity mismatch.');
        this.#transcript ??= new AgentTranscript(this.tui, this.keybindings, this.host.toolPresentation?.bind(this.host), () => this.theme);
        if (session) this.#transcript.attach(session);
        else if (projection) this.#transcript.showProjection(projection);
      } catch (error) {
        this.#transcript?.dispose();
        this.#transcript = undefined;
        this.#statusMessage = `Unable to render transcript: ${activityLine(error instanceof Error ? error.message : String(error))}`;
      }
    }
    if (selectedChanged) this.host.selectAgent?.(record?.id);
  }

  #selectedRecord(): AgentNavigatorRecord | undefined {
    return this.#selectedId ? this.host.getLocalSubagent(this.#selectedId) : undefined;
  }

  #moveSelection(delta: number): void {
    if (this.#records.length === 0) return;
    const current = Math.max(
      0,
      this.#records.findIndex((record) => record.id === this.#selectedId),
    );
    const next = Math.max(0, Math.min(this.#records.length - 1, current + delta));
    if (next === current) return;
    this.#focusNavigation(true);
    this.#selectedId = this.#records[next]!.id;
    this.#statusMessage = '';
    this.#syncSelectedRecord();
  }

  #focusInput(): void {
    if (this.#selectedRecord()?.state !== 'running' || this.tui.terminal.rows < 5) return;
    this.#inputFocused = true;
    this.#input.focused = this.focused;
  }

  #focusNavigation(clearDraft = false): void {
    this.#inputFocused = false;
    this.#input.focused = false;
    if (clearDraft) this.#input.setValue('');
  }

  async #stopSelected(): Promise<void> {
    if (this.#controlPending) return;
    const record = this.#selectedRecord();
    if (!record || (record.state !== 'running' && record.state !== 'queued')) {
      this.#statusMessage = record
        ? `Subagent is ${formatStatus(record.state)}.`
        : 'Select a running or queued subagent first.';
      return;
    }
    this.#statusMessage = `Stopping ${record.label}…`;
    this.#controlPending = true;
    this.tui.requestRender();
    try {
      const result = await this.host.cancel(record.id, 'Stopped from the agent navigator');
      if (this.#closed) return;
      this.#statusMessage = result.ok ? `Stopped ${record.label}.` : activityLine(result.error.message);
    } catch (error) {
      if (!this.#closed) this.#statusMessage = activityLine(error instanceof Error ? error.message : String(error));
    } finally {
      this.#controlPending = false;
      if (!this.#closed) { this.#refreshRecords(); this.tui.requestRender(); }
    }
  }

  async #submitSteer(value: string): Promise<void> {
    if (this.#controlPending) return;
    const message = value.trim();
    const record = this.#selectedRecord();
    if (!message || !record || record.state !== 'running') return;
    const agentId = record.id;
    this.#controlPending = true;
    this.#statusMessage = `Sending message to ${record.label}…`;
    this.tui.requestRender();
    try {
      const result = await this.host.steer(agentId, message);
      if (this.#closed) return;
      this.#statusMessage = result.ok ? `Message sent to ${record.label}.` : activityLine(result.error.message);
      if (result.ok && this.#selectedId === agentId && this.#input.getValue() === value) this.#input.setValue('');
    } catch (error) {
      if (!this.#closed) this.#statusMessage = activityLine(error instanceof Error ? error.message : String(error));
    } finally {
      this.#controlPending = false;
      if (!this.#closed) this.tui.requestRender();
    }
  }

  #scrollBy(delta: number): void {
    const maxScroll = Math.max(0, this.#lastContentLength - this.#lastViewportHeight);
    const nextOffset = Math.max(0, Math.min(maxScroll, this.#scrollOffset + delta));
    this.#scrollOffset = nextOffset;
    this.#autoScroll = nextOffset >= maxScroll;
  }

  #renderTranscript(
    width: number,
    height: number,
    selected: AgentNavigatorRecord | undefined,
  ): string[] {
    if (height <= 0) return [];
    let content: string[];
    if (!selected) {
      content = [this.theme.fg('dim', 'No subagents to show. Press Esc/q to close.')];
    } else if (!selected.liveSession && !selected.projection) {
      content = this.#renderUnavailableTranscript(selected, width);
    } else {
      content = this.#transcript?.render(width) ?? [];
      if (content.length === 0) content = [this.theme.fg('dim', 'Waiting for the first message…')];
    }

    this.#lastContentLength = content.length;
    const maxScroll = Math.max(0, content.length - height);
    if (this.#autoScroll) this.#scrollOffset = maxScroll;
    else this.#scrollOffset = Math.min(this.#scrollOffset, maxScroll);
    const visible = content.slice(this.#scrollOffset, this.#scrollOffset + height);
    return [...visible, ...Array<string>(Math.max(0, height - visible.length)).fill('')];
  }

  #renderUnavailableTranscript(record: AgentNavigatorRecord, width: number): string[] {
    if (record.transcriptStatus) return [this.theme.fg('dim', activityLine(record.transcriptStatus))];
    if (record.result?.error && !record.result.text) return [this.theme.fg('error', record.result.error)];
    if (record.result) {
      const text = stripTerminalSequences(record.result.text);
      return text.split('\n').flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
    }
    const state = record.state === 'queued'
      ? 'Waiting for an execution slot…'
      : `Session unavailable (${formatStatus(record.state)}).`;
    return [this.theme.fg('dim', state)];
  }

  #renderHeader(selected: LocalSubagentView | undefined): string {
    if (!selected) {
      return this.theme.bold('Agent navigator') + this.theme.fg('dim', ' · no subagents · Esc closes');
    }
    const model = modelLabel(selected);
    const metadata = [
      model,
      describeActivity(selected),
      formatCost(selected),
      formatDuration(selected),
    ].filter(Boolean).join(' · ');
    return this.theme.bold(`Viewing ${selected.label}`)
      + this.theme.fg('dim', ` · ${metadata} · Esc returns`);
  }

  #renderInput(width: number, selected: LocalSubagentView): string {
    const fullLabel = `Message ${selected.label}… `;
    const labelText = visibleWidth(fullLabel) <= Math.max(1, width - 4) ? fullLabel : '> ';
    const label = this.theme.fg('accent', labelText);
    const inputWidth = Math.max(1, width - visibleWidth(label));
    return label + (this.#input.render(inputWidth)[0] ?? '');
  }

  #renderRail(width: number, maxRows: number): string[] {
    if (maxRows <= 0) return [];
    const selectedIndex = Math.max(
      0,
      this.#records.findIndex((record) => record.id === this.#selectedId),
    );
    const windowSize = Math.min(maxRows, this.#records.length);
    const maxStart = Math.max(0, this.#records.length - windowSize);
    const start = Math.max(0, Math.min(maxStart, selectedIndex - Math.floor(windowSize / 2)));
    const visibleItems = this.#records.slice(start, start + windowSize);

    return visibleItems.map((item, index) => {
      const indicators: string[] = [];
      if (index === 0 && start > 0) indicators.push(`↑${start}`);
      const below = this.#records.length - (start + windowSize);
      if (index === visibleItems.length - 1 && below > 0) indicators.push(`↓${below}`);
      const indicator = indicators.length > 0
        ? this.theme.fg('dim', `${indicators.join(' ')} `)
        : '';
      return indicator + this.#renderRailItem(
        item,
        item.id === this.#selectedId,
        Math.max(0, width - visibleWidth(indicator)),
      );
    });
  }

  #renderRailItem(item: LocalSubagentView, selected: boolean, width: number): string {
    return renderAgentRow(item, selected, this.theme, width);
  }

  #renderHints(): string {
    const keyHint = (key: string, label: string) => `${this.theme.fg('accent', key)} ${this.theme.fg('dim', label)}`;
    const hints = [
      keyHint('↑↓', 'select'),
      keyHint('Enter/Tab', 'view/message'),
      keyHint('wheel/PgUp/PgDn', 'scroll'),
      keyHint('x', 'stop'),
      keyHint('q/Esc', 'close'),
    ];
    if (this.#transcript) {
      const transcriptHints = this.#transcript.getToggleHints();
      hints.splice(3, 0, transcriptHints.tools, transcriptHints.thinking);
    }
    return hints.join(this.theme.fg('dim', ' · '));
  }

  #fitLine(line: string, width: number): string {
    const truncated = truncateToWidth(line, width);
    return truncated + ' '.repeat(Math.max(0, width - visibleWidth(truncated)));
  }
}

function frameOverlayLines(lines: readonly string[], width: number, theme: Theme): string[] {
  const border = (text: string) => theme.fg('border', text);
  const innerWidth = Math.max(1, width - 2);
  return [
    border(`╭${'─'.repeat(innerWidth)}╮`),
    ...lines.map((line) => `${border('│')}${truncateToWidth(line, innerWidth, '', true)}${border('│')}`),
    border(`╰${'─'.repeat(innerWidth)}╯`),
  ];
}

export async function openAgentNavigator(
  ctx: ExtensionContext,
  host: AgentNavigatorHost,
  initialAgentId?: string,
): Promise<void> {
  let navigator: AgentNavigator | undefined;
  let escapeRequested = false;
  const unsubscribe = ctx.ui.onTerminalInput((data) => {
    if (!matchesKey(data, Key.escape)) return undefined;
    escapeRequested = true;
    navigator?.close();
    return { consume: true };
  });

  try {
    await ctx.ui.custom<void>(
      (tui, theme, keybindings, done) => {
        navigator = new AgentNavigator(
          tui,
          host,
          theme,
          keybindings,
          () => done(undefined),
          initialAgentId,
        );
        if (escapeRequested) queueMicrotask(() => navigator?.close());
        return navigator;
      },
      { overlay: true, overlayOptions: AGENT_NAVIGATOR_OVERLAY_OPTIONS },
    );
  } finally {
    unsubscribe();
  }
}

export function registerLocalSubagentNavigator(
  pi: Pick<
    FelanExtensionAPI,
    'on' | 'registerCommand' | 'registerMessageRenderer' | 'registerShortcut'
  >,
  host: LocalSubagentNavigatorHost,
  options: LocalSubagentNavigatorOptions = {},
): void {
  registerSubagentCompletionRenderer(pi);
  let controlsRegistered = false;
  let stopRail = () => {};
  pi.on('session_start', (_event, ctx) => {
    stopRail();
    if (ctx.mode !== 'tui') return;
    const open = (commandContext: ExtensionContext) => openAgentNavigator(commandContext, host);
    if (!controlsRegistered) {
      controlsRegistered = true;
      pi.registerCommand('agents', {
        description: 'Open the subagent navigator',
        handler: async (_args, commandContext) => open(commandContext),
      });
      pi.registerShortcut(AGENT_NAVIGATOR_SHORTCUT, {
        description: 'Open the subagent navigator',
        handler: open,
      });
    }

    let editor: AgentRailEditor | undefined;
    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
      editor = new AgentRailEditor(
        tui,
        editorTheme,
        keybindings,
        host,
        () => ctx.ui.theme,
        (agentId) => {
          void openAgentNavigator(ctx, host, agentId);
        },
        options.renderRailInEditor ?? (() => true),
      );
      return editor;
    });
    options.onRailRendererChange?.((width) => editor?.renderRail(width) ?? []);
    let hadActiveSubagents = activeSubagents(host).length > 0;
    const refreshInterval = setInterval(() => {
      const hasActiveSubagents = activeSubagents(host).length > 0;
      if (hasActiveSubagents || hadActiveSubagents) editor?.refresh();
      hadActiveSubagents = hasActiveSubagents;
    }, ACTIVE_RAIL_REFRESH_INTERVAL_MS);
    refreshInterval.unref?.();
    stopRail = () => {
      clearInterval(refreshInterval);
      editor = undefined;
      options.onRailRendererChange?.(undefined);
      stopRail = () => {};
    };
  });
  pi.on('session_shutdown', () => stopRail());
}

function activeSubagents(host: Pick<AgentNavigatorHost, 'listLocalSubagents'>): AgentNavigatorRecord[] {
  return [...host.listLocalSubagents()]
    .filter((record) => record.state === 'queued' || record.state === 'running');
}

function renderAgentRow(
  record: LocalSubagentView,
  selected: boolean,
  theme: Theme,
  width: number,
): string {
  if (width <= 0) return '';
  const cursor = selected ? theme.fg('accent', '›') : ' ';
  const name = selected ? theme.bold(record.label ?? 'session') : record.label ?? 'session';
  const baseHead = `${cursor} ${statusIcon(record, theme)} ${name}`;
  const model = modelLabel(record);
  const head = truncateToWidth(
    baseHead + (model ? theme.fg('dim', ` · ${model}`) : ''),
    width,
    '…',
  );
  const metrics = [formatCost(record), formatDuration(record)].filter(Boolean).join(' · ');
  const metricsWidth = visibleWidth(metrics);
  const summary = record.state === 'running'
    ? describeActivity(record)
    : activityLine(record.description ?? '');
  const summaryWidth = Math.max(
    0,
    width - visibleWidth(head) - 2 - (metricsWidth > 0 ? metricsWidth + 2 : 0),
  );
  const renderedSummary = summaryWidth > 0
    ? theme.fg('dim', truncateToWidth(summary, summaryWidth, '…'))
    : '';
  const left = truncateToWidth(
    renderedSummary ? `${head}  ${renderedSummary}` : head,
    width,
    '',
  );
  const available = width - visibleWidth(left);
  const renderedMetrics = metricsWidth > 0 && available >= metricsWidth + 1
    ? `${' '.repeat(Math.max(2, available - metricsWidth))}${theme.fg('dim', metrics)}`
    : '';
  const line = truncateToWidth(left + renderedMetrics, width, '');
  return line + ' '.repeat(Math.max(0, width - visibleWidth(line)));
}

function hideEditorCursor(lines: string[]): void {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const start = line.indexOf('\x1b[7m');
    if (start < 0) continue;
    const end = line.indexOf('\x1b[0m', start + 4);
    if (end < 0) return;
    lines[index] = line.slice(0, start) + line.slice(start + 4, end) + line.slice(end + 4);
    return;
  }
}

function statusIcon(record: LocalSubagentView, theme: Theme): string {
  if (record.state === 'running') return theme.fg('accent', '●');
  if (record.state === 'queued') return theme.fg('muted', '◦');
  if (record.state === 'completed') return theme.fg('success', '✓');
  if (record.state === 'failed') return theme.fg('error', '✗');
  return theme.fg('dim', '■');
}

function describeActivity(record: AgentNavigatorRecord): string {
  if (record.state !== 'running') return formatStatus(record.state);
  if (record.activity !== undefined) return activityLine(record.activity);
  const session = record.liveSession;
  if (!session) return 'starting…';

  const pendingToolCalls = session.state.pendingToolCalls;
  if (pendingToolCalls.size > 0) {
    const toolNames = new Set<string>();
    const messages = session.state.streamingMessage
      ? [...session.messages, session.state.streamingMessage]
      : session.messages;
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      for (const content of message.content) {
        if (content.type === 'toolCall' && pendingToolCalls.has(content.id)) toolNames.add(content.name);
      }
    }
    return toolNames.size > 0
      ? `using ${[...toolNames].join(', ')}…`
      : `${pendingToolCalls.size} tool ${pendingToolCalls.size === 1 ? 'call' : 'calls'} running…`;
  }

  const streaming = session.state.streamingMessage;
  if (streaming?.role === 'assistant') {
    const response = streaming.content
      .filter((content) => content.type === 'text')
      .map((content) => content.text)
      .join('');
    if (response.trim()) return activityLine(response);
  }
  return 'thinking…';
}

function activityLine(text: string): string {
  return stripTerminalSequences(text)
    .split(/\r?\n/)
    .find((candidate) => candidate.trim())
    ?.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, ' ')
    .trim() ?? '';
}

function modelLabel(record: LocalSubagentView): string {
  const sessionModel = record.liveSession?.model;
  const model = record.model ? `${record.model.provider}/${record.model.id}`
    : sessionModel ? `${sessionModel.provider}/${sessionModel.id}` : undefined;
  return model ? activityLine(model) : '';
}

function formatStatus(status: LocalSubagentView['state']): string {
  return status.replaceAll('_', ' ');
}

function formatDuration(record: LocalSubagentView): string {
  const start = Date.parse(record.startedAt ?? record.createdAt ?? '');
  const end = record.completedAt ? Date.parse(record.completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  const seconds = Math.max(0, end - start) / 1_000;
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

function formatCost(record: LocalSubagentView): string {
  const cost = record.usage?.cost;
  return cost !== undefined && Number.isFinite(cost) && cost >= 0
    ? `$${cost.toFixed(3)}`
    : '';
}
