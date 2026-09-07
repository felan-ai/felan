import type { ExtensionContext } from '@felan-ai/agent-core';
import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from '@earendil-works/pi-tui';
import { LocalSessionPicker } from '../session-picker.js';
import { AgentTranscript } from '../subagents/agent-transcript.js';
import {
  listLocalSessionHistory,
  readMemoryHistorySnapshot,
  safeMemoryText,
  type LocalSessionHistory,
  type MemoryHistorySession,
  type MemoryHistorySnapshot,
} from './history.js';

export async function showMemoryHistory(ctx: ExtensionContext, agentDir: string, status: string): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== 'tui') {
    ctx.ui.notify('/memory requires interactive TUI mode.', 'warning');
    return;
  }
  const history = await listLocalSessionHistory({
    cwd: ctx.cwd, agentDir, sessionDir: ctx.sessionManager.getSessionDir(), memoryOnly: true,
  });
  await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => new MemoryHistoryView(tui, history, done, {
    memoryOnly: true,
    keybindings,
    status,
    theme,
  }));
}

interface MemoryHistoryViewOptions {
  readonly memoryOnly?: boolean;
  readonly keybindings?: Pick<KeybindingsManager, 'matches'>;
  readonly status?: string;
  readonly theme?: Theme;
}

export class MemoryHistoryView implements Component, Focusable {
  readonly #picker: LocalSessionPicker;
  readonly #keybindings: Pick<KeybindingsManager, 'matches'>;
  #selected: MemoryHistorySession | undefined;
  #snapshot: MemoryHistorySnapshot | undefined;
  #transcript: AgentTranscript | undefined;
  #error: string | undefined;
  #scroll = 0;
  #maximumScroll = 0;
  #viewportHeight = 1;
  #generation = 0;
  #closed = false;

  constructor(
    private readonly tui: TUI,
    private readonly history: LocalSessionHistory,
    private readonly done: (path: string | undefined) => void,
    private readonly options: MemoryHistoryViewOptions = {},
  ) {
    this.#keybindings = options.keybindings ?? {
      matches: (data, action) => (action === 'app.tools.expand' && matchesKey(data, Key.ctrl('o')))
        || (action === 'app.thinking.toggle' && matchesKey(data, Key.ctrl('t'))),
    };
    this.#picker = new LocalSessionPicker(history.currentSessions, history.allSessions, (path) => {
      const memory = history.memorySessions.get(path);
      if (memory) void this.#inspect(memory);
      else this.#finish(path);
    }, () => this.#finish(undefined), () => tui.requestRender(), options.memoryOnly
      ? { title: 'Memory Runs', selectLabel: 'inspect' }
      : { selectLabel: 'resume / inspect Memory' });
  }

  get focused(): boolean { return this.#picker.focused; }
  set focused(value: boolean) { this.#picker.focused = value; }

  render(width: number): string[] {
    const renderWidth = Math.max(1, Math.floor(width));
    if (!this.#selected) {
      const picker = this.options.memoryOnly && this.history.allSessions.length === 0
        ? [
            truncateToWidth('Memory Runs', renderWidth),
            truncateToWidth('Esc close', renderWidth),
            '',
            truncateToWidth('No retained memory runs.', renderWidth),
          ]
        : this.#picker.render(width);
      const content = this.options.status
        ? [...wrapTextWithAnsi(this.options.status, renderWidth), '', ...picker]
        : picker;
      return this.#frame(content, renderWidth);
    }
    const lines = [truncateToWidth(`Memory run ${this.#selected.id} · read-only`, renderWidth)];
    const body = this.#snapshot ? snapshotDetails(this.#snapshot).flatMap((line) => wrapTextWithAnsi(line, renderWidth))
      : [this.#error ?? 'Loading retained transcript…'];
    if (this.#snapshot) {
      try {
        body.push('', ...(this.#transcript?.render(renderWidth) ?? ['Transcript could not be rendered.']));
      } catch {
        body.push('', 'Transcript contains entries that could not be rendered.');
      }
    }
    this.#viewportHeight = Math.max(1, (this.tui.terminal.rows || 24) - 7);
    this.#maximumScroll = Math.max(0, body.length - this.#viewportHeight);
    this.#scroll = Math.min(this.#scroll, this.#maximumScroll);
    lines.push(...body.slice(this.#scroll, this.#scroll + this.#viewportHeight));
    const hints = this.options.keybindings && this.#transcript ? this.#transcript.getToggleHints() : undefined;
    lines.push(truncateToWidth(`↑↓/PgUp/PgDn scroll  ${hints ? `${hints.tools}  ${hints.thinking}` : 'Ctrl+O tools  Ctrl+T thinking'}  Esc back`, renderWidth));
    return this.#frame(lines, renderWidth);
  }

  handleInput(data: string): void {
    if (this.#closed) return;
    if (!this.#selected) { this.#picker.handleInput(data); return; }
    const wheelDirection = parseWheelDirection(data);
    if (wheelDirection !== undefined) {
      this.#scroll = Math.max(0, Math.min(this.#maximumScroll, this.#scroll + wheelDirection));
    } else if (matchesKey(data, Key.escape)) {
      this.#generation += 1;
      this.#selected = undefined;
      this.#snapshot = undefined;
      this.#transcript?.dispose();
      this.#transcript = undefined;
    } else if (matchesKey(data, Key.up)) this.#scroll = Math.max(0, this.#scroll - 1);
    else if (matchesKey(data, Key.down)) this.#scroll = Math.min(this.#maximumScroll, this.#scroll + 1);
    else if (matchesKey(data, Key.pageUp)) this.#scroll = Math.max(0, this.#scroll - this.#viewportHeight);
    else if (matchesKey(data, Key.pageDown)) this.#scroll = Math.min(this.#maximumScroll, this.#scroll + this.#viewportHeight);
    else if (matchesKey(data, Key.home)) this.#scroll = 0;
    else if (matchesKey(data, Key.end)) this.#scroll = this.#maximumScroll;
    else this.#transcript?.handleInput(data);
    this.tui.requestRender();
  }

  #frame(lines: readonly string[], width: number): string[] {
    if (!this.options.memoryOnly) return [...lines];
    const theme = this.options.theme;
    if (!theme || typeof theme.fg !== 'function') return [
      '─'.repeat(width),
      ...lines.map((line) => truncateToWidth(line, width, '', true)),
      '─'.repeat(width),
    ];
    const border = theme.fg('border', '─'.repeat(width));
    return [border, ...lines.map((line) => truncateToWidth(line, width, '', true)), border];
  }

  invalidate(): void {
    this.#picker.invalidate();
    this.#transcript?.invalidate();
  }

  dispose(): void {
    this.#closed = true;
    this.#generation += 1;
    this.#transcript?.dispose();
  }

  #finish(path: string | undefined): void {
    this.dispose();
    this.done(path);
  }

  async #inspect(session: MemoryHistorySession): Promise<void> {
    const generation = ++this.#generation;
    this.#selected = session;
    this.#snapshot = undefined;
    this.#error = undefined;
    this.#scroll = 0;
    this.#transcript?.dispose();
    this.#transcript = undefined;
    this.tui.requestRender();
    try {
      const snapshot = await readMemoryHistorySnapshot(session);
      if (this.#closed || generation !== this.#generation) return;
      this.#snapshot = snapshot;
      const transcript = new AgentTranscript(this.tui, this.#keybindings);
      this.#transcript = transcript;
      try { transcript.showSnapshot(snapshot.messages, session.cwd); }
      catch { transcript.dispose(); this.#transcript = undefined; }
    } catch {
      if (this.#closed || generation !== this.#generation) return;
      this.#error = 'Memory history could not be read. Esc returns without changing the run.';
    }
    this.tui.requestRender();
  }
}

function snapshotDetails(snapshot: MemoryHistorySnapshot): string[] {
  const { session, metadata } = snapshot;
  const details = [
    `Project: ${safeMemoryText(session.cwd)}`,
    `Status: ${metadata?.status ?? 'unknown'}${metadata ? ` · Phase: ${metadata.phase}` : ''}`,
    `Transcript: ${safeMemoryText(session.path)}`,
    `Artifacts: ${safeMemoryText(session.memory.manifestPath)}`,
  ];
  if (metadata) {
    details.push(`Started: ${safeMemoryText(metadata.startedAt)}${metadata.finishedAt ? ` · Finished: ${safeMemoryText(metadata.finishedAt)}` : ''}`);
    if (metadata.model) details.push(`Model: ${safeMemoryText(`${metadata.model.provider}/${metadata.model.id}`)}`);
    if (metadata.error) details.push(`Error: ${safeMemoryText(metadata.error)}`);
  }
  details.push(...snapshot.diagnostics);
  if (snapshot.messages.length === 0) details.push('No messages were retained. The run may have stopped before the worker started.');
  else if (!snapshot.messages.some((message) => message.role === 'assistant')) details.push('No assistant response was retained.');
  return details;
}

function parseWheelDirection(data: string): -1 | 1 | undefined {
  const sgr = /^\x1b\[<(\d+);\d+;\d+[Mm]$/u.exec(data);
  const button = sgr?.[1];
  if (button !== undefined) return wheelDirection(Number.parseInt(button, 10));
  if (data.length === 6 && data.startsWith('\x1b[M')) return wheelDirection(data.charCodeAt(3) - 32);
  return undefined;
}

function wheelDirection(button: number): -1 | 1 | undefined {
  if ((button & 64) === 0) return undefined;
  const direction = button & 3;
  if (direction === 0) return -1;
  if (direction === 1) return 1;
  return undefined;
}
