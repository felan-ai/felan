import type { ExtensionContext } from '@felan-ai/agent-core';
import type { KeybindingsManager } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from '@earendil-works/pi-tui';
import { LocalSessionPicker } from '../session-picker.js';
import { AgentTranscript } from '../subagents/agent-transcript.js';
import {
  findMemoryHistorySession,
  listLocalSessionHistory,
  readMemoryHistorySnapshot,
  safeMemoryText,
  validMemoryRunId,
  type LocalSessionHistory,
  type MemoryHistorySession,
  type MemoryHistorySnapshot,
} from './history.js';

export async function showMemoryHistory(ctx: ExtensionContext, agentDir: string, id?: string): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== 'tui') {
    ctx.ui.notify('/memory runs requires interactive TUI mode.', 'warning');
    return;
  }
  if (id !== undefined && id !== 'latest' && !validMemoryRunId(id)) {
    ctx.ui.notify('Use /memory runs <id|latest>, not a file path.', 'warning');
    return;
  }
  const history = await listLocalSessionHistory({
    cwd: ctx.cwd, agentDir, sessionDir: ctx.sessionManager.getSessionDir(), memoryOnly: true,
  });
  const initialSession = id === undefined ? undefined : findMemoryHistorySession(history, id);
  if (id !== undefined && !initialSession) {
    ctx.ui.notify('No retained memory run found for this project.', 'warning');
    return;
  }
  if (history.allSessions.length === 0) {
    ctx.ui.notify('No retained memory runs.', 'info');
    return;
  }
  await ctx.ui.custom<string | undefined>((tui, _theme, keybindings, done) => new MemoryHistoryView(tui, history, done, {
    memoryOnly: true, keybindings, ...(initialSession ? { initialSession } : {}),
  }));
}

interface MemoryHistoryViewOptions {
  readonly memoryOnly?: boolean;
  readonly initialSession?: MemoryHistorySession;
  readonly keybindings?: Pick<KeybindingsManager, 'matches'>;
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
    if (options.initialSession) void this.#inspect(options.initialSession);
  }

  get focused(): boolean { return this.#picker.focused; }
  set focused(value: boolean) { this.#picker.focused = value; }

  render(width: number): string[] {
    if (!this.#selected) return this.#picker.render(width);
    const lines = [truncateToWidth(`Memory run ${this.#selected.id} · read-only`, width)];
    const body = this.#snapshot ? snapshotDetails(this.#snapshot).flatMap((line) => wrapTextWithAnsi(line, width))
      : [this.#error ?? 'Loading retained transcript…'];
    if (this.#snapshot) {
      try {
        body.push('', ...(this.#transcript?.render(width) ?? ['Transcript could not be rendered.']));
      } catch {
        body.push('', 'Transcript contains entries that could not be rendered.');
      }
    }
    this.#viewportHeight = Math.max(1, (this.tui.terminal.rows || 24) - 5);
    this.#maximumScroll = Math.max(0, body.length - this.#viewportHeight);
    this.#scroll = Math.min(this.#scroll, this.#maximumScroll);
    lines.push(...body.slice(this.#scroll, this.#scroll + this.#viewportHeight));
    const hints = this.options.keybindings && this.#transcript ? this.#transcript.getToggleHints() : undefined;
    lines.push(truncateToWidth(`↑↓/PgUp/PgDn scroll  ${hints ? `${hints.tools}  ${hints.thinking}` : 'Ctrl+O tools  Ctrl+T thinking'}  Esc ${this.options.initialSession ? 'close' : 'back'}`, width));
    return lines;
  }

  handleInput(data: string): void {
    if (this.#closed) return;
    if (!this.#selected) { this.#picker.handleInput(data); return; }
    if (matchesKey(data, Key.escape)) {
      if (this.options.initialSession) this.#finish(undefined);
      else {
        this.#generation += 1;
        this.#selected = undefined;
        this.#snapshot = undefined;
        this.#transcript?.dispose();
        this.#transcript = undefined;
      }
    } else if (matchesKey(data, Key.up)) this.#scroll = Math.max(0, this.#scroll - 1);
    else if (matchesKey(data, Key.down)) this.#scroll = Math.min(this.#maximumScroll, this.#scroll + 1);
    else if (matchesKey(data, Key.pageUp)) this.#scroll = Math.max(0, this.#scroll - this.#viewportHeight);
    else if (matchesKey(data, Key.pageDown)) this.#scroll = Math.min(this.#maximumScroll, this.#scroll + this.#viewportHeight);
    else if (matchesKey(data, Key.home)) this.#scroll = 0;
    else if (matchesKey(data, Key.end)) this.#scroll = this.#maximumScroll;
    else this.#transcript?.handleInput(data);
    this.tui.requestRender();
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
