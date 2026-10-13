import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import { Container, Key, Loader, matchesKey, getKeybindings, ScrollView, Text, VStack, type Component, type TUI } from '@earendil-works/pi-tui';
import type { AgentViewTranscript } from '../subagents/types.js';
import { AgentTranscript, type AgentToolPresentation } from '../subagents/agent-transcript.js';
import { TuiSessionController } from './controller.js';
import { projectTuiTranscript } from './transcript.js';
import { TuiDialogs } from './dialogs.js';
import { createCommandAutocomplete, submitTuiInput, type DaemonAction } from './commands.js';
import { statusText, uiText } from '../client/ui.js';
import type { Execution, Presentation } from '@felan-ai/session-protocol';
import { AgentRailEditor } from '../subagents/agent-navigator.js';
import { clientSelectListTheme, defaultClientTheme } from './theme.js';
import { isPowerlinePresentation } from '../client/powerline-presenter.js';
import { startupHeader } from './startup-header.js';

const WORKING_FRAMES = ['⠐◉ ', '⠈◉ ', ' ◉⠁', ' ◉⠂', ' ◉⠄', '⠠◉ '];

export class DaemonTuiScreen {
  readonly editor: AgentRailEditor;
  readonly transcript: AgentTranscript;
  readonly scroll: ScrollView;
  readonly component: Component;
  readonly dialogs: TuiDialogs;
  private readonly activity = new Container();
  private readonly notices = new Container();
  private readonly header = new Text('', 1, 1);
  private readonly footer = new Container();
  private readonly inline = new Container();
  private executions: readonly Execution[] = [];
  private inlineActive = false;
  private readonly theme: () => Theme;
  private working: Loader | undefined;
  private lastClear = 0;
  private readonly unsubscribe: () => void;
  private readonly removeInput: () => void;
  private readonly keys = getKeybindings();
  private disposed = false;
  private submitting: Promise<void> | undefined;
  private queuedSubmit: string | undefined;

  constructor(private readonly controller: TuiSessionController, private readonly tui: TUI, private readonly options: {
    cwd: string;
    exit(): void;
    daemon?(action: DaemonAction, force: boolean): Promise<void>;
    preferences?(): Promise<boolean>;
    login?(provider?: string): Promise<boolean>;
    logout?(): Promise<boolean>;
    dependencies?(): Promise<boolean>;
    ui?(): Promise<boolean>;
    hasRenderer?(element: Presentation): boolean;
    agents?(id?: string): Promise<void>;
    settings?: () => AgentViewTranscript['settings'];
    toolPresentation?: (name: string) => AgentToolPresentation | undefined;
    theme?: () => Theme;
  }) {
    const initialTheme = options.theme ? undefined : defaultClientTheme();
    const theme = options.theme ?? (() => initialTheme!);
    this.theme = theme;
    const selectList = clientSelectListTheme(theme);
    this.dialogs = new TuiDialogs(tui, theme, component => this.showInline(component));
    this.editor = new AgentRailEditor(tui, { borderColor: text => (this.editor?.getText().trimStart().startsWith('!')
      ? theme().getBashModeBorderColor() : theme().getThinkingBorderColor(controller.snapshot?.thinking ?? 'off'))(text), selectList },
    this.keys as unknown as KeybindingsManager, { listLocalSubagents: () => this.executions }, theme,
    id => { void options.agents?.(id).catch(error => controller.setNotice(errorText(error))); }, () => false);
    this.editor.setPaddingX(1);
    this.editor.setAutocompleteProvider(createCommandAutocomplete(controller));
    this.transcript = new AgentTranscript(tui, this.keys, options.toolPresentation, theme);
    const content = new Container();
    content.addChild(this.header); content.addChild(this.transcript); content.addChild(this.notices);
    this.scroll = new ScrollView(content, { follow: 'end', primary: true, scrollbar: 'auto' });
    const stack = new VStack([{ component: this.scroll, basis: 0, grow: 1, minSize: 0 },
      { component: this.activity, shrink: 0, visible: () => !this.inlineActive },
      { component: this.editor, shrink: 0, visible: () => !this.inlineActive },
      { component: this.inline, visible: () => this.inlineActive, shrink: 1, minSize: 1 },
      { component: { render: width => this.editor.renderRail(width), invalidate() {} }, shrink: 0 },
      { component: this.footer, shrink: 0 }]);
    this.component = stack;
    this.editor.onSubmit = text => {
      this.editor.setText(text);
      if (this.submitting) { this.queuedSubmit = text; this.editor.addToHistory(text); this.editor.setText(''); }
      else this.trackSubmission(this.submit(text));
    };
    this.removeInput = tui.addInputListener(data => {
      if (tui.hasOverlay() || this.inlineActive) return undefined;
      if (matchesKey(data, Key.alt('a'))) { this.action('/agents'); return { consume: true }; }
      if (this.keys.matches(data, 'app.exit') && !this.editor.getText()) { options.exit(); return { consume: true }; }
      if (this.keys.matches(data, 'app.interrupt') && !this.editor.isRailFocused() && controller.snapshot && !['idle', 'interrupted'].includes(controller.snapshot.run.state)) {
        void controller.cancel().catch(error => controller.setNotice(errorText(error))); return { consume: true };
      }
      if (this.keys.matches(data, 'app.clear')) {
        this.queuedSubmit = undefined;
        const now = Date.now();
        if (now - this.lastClear < 500) options.exit();
        else { this.editor.setText(''); this.lastClear = now; tui.requestRender(); }
        return { consume: true };
      }
      if (this.keys.matches(data, 'app.model.select')) { this.action('/model'); return { consume: true }; }
      for (const [key, command] of [['app.session.new', '/new'], ['app.session.tree', '/tree'], ['app.session.fork', '/fork'], ['app.session.resume', '/sessions']] as const) {
        if (this.keys.matches(data, key)) { this.action(command); return { consume: true }; }
      }
      if (this.keys.matches(data, 'app.model.cycleForward') || this.keys.matches(data, 'app.model.cycleBackward')) {
        const models = controller.snapshot?.catalog.models ?? []; const current = controller.snapshot?.model;
        const at = models.findIndex(model => model.provider === current?.provider && model.id === current?.id);
        const step = this.keys.matches(data, 'app.model.cycleBackward') ? -1 : 1;
        if (models.length) { const model = models[(at + step + models.length) % models.length]!; this.action(`/model ${model.provider}/${model.id}`); }
        return { consume: true };
      }
      if (this.keys.matches(data, 'app.thinking.cycle')) {
        const snapshot = controller.snapshot;
        if (snapshot) {
          const model = snapshot.catalog.models.find(model => model.provider === snapshot.model.provider && model.id === snapshot.model.id);
          if (model?.thinking.length) this.action(`/thinking ${model.thinking[(model.thinking.indexOf(snapshot.thinking) + 1) % model.thinking.length]}`);
        }
        return { consume: true };
      }
      if (this.keys.matches(data, 'app.message.followUp')) {
        const text = this.editor.getExpandedText();
        if (text && !this.submitting) {
          this.editor.addToHistory(text); this.editor.setText('');
          this.trackSubmission(controller.submit(text, 'follow_up').then(accepted => {
            if (!accepted && !this.editor.getText()) this.editor.setText(text);
          }).catch(error => {
            if (!this.editor.getText()) this.editor.setText(text);
            controller.setNotice(errorText(error));
          }).finally(() => { tui.requestRender(); }));
        }
        return { consume: true };
      }
      if (this.transcript.handleInput(data)) return { consume: true };
      return undefined;
    });
    this.unsubscribe = controller.subscribe(() => this.refresh()); this.refresh();
  }

  focus(): void { this.tui.setFocus(this.editor); }
  refreshPresentation(): void {
    this.working?.setIndicator(this.workingIndicator());
    this.component.invalidate(); this.refresh(); this.tui.requestRender(true);
  }
  setFooter(component?: Component): void {
    this.footer.clear(); if (component) this.footer.addChild(component); this.tui.requestRender();
  }
  setExecutions(executions: readonly Execution[]): void {
    this.executions = executions; this.tui.requestRender();
  }

  private showInline(component: Component): () => void {
    this.inlineActive = true; this.inline.addChild(component); this.tui.setFocus(component); this.tui.requestRender();
    return () => {
      this.inline.removeChild(component); this.inlineActive = false;
      this.focus(); this.tui.requestRender();
    };
  }

  private action(command: string): void {
    if (!this.submitting) this.trackSubmission(this.submit(command, true));
  }

  private trackSubmission(pending: Promise<void>): void {
    this.submitting = pending.finally(() => {
      this.submitting = undefined;
      const text = this.queuedSubmit; this.queuedSubmit = undefined;
      if (!this.disposed && text !== undefined && !this.editor.getExpandedText()) this.trackSubmission(this.submit(text));
    });
  }

  async submit(text: string, preserveDraft = false): Promise<void> {
    if (!preserveDraft) { this.editor.addToHistory(text); this.editor.setText(''); this.tui.requestRender(); }
    try {
      if (/^\/agents(?:\s|$)/u.test(text.trim())) {
        await this.options.agents?.(text.trim().slice(7).trim() || undefined);
        return;
      }
      if (await submitTuiInput(this.controller, this.dialogs, text, { ...this.options, setDraft: value => this.editor.setText(value) })) {
        if (!preserveDraft) {
          this.scroll.scrollToEnd();
        }
      } else if (!preserveDraft && !text.trimStart().startsWith('/') && !this.editor.getText()) this.editor.setText(text);
    } catch (error) {
      if (!preserveDraft && !text.trimStart().startsWith('/') && !this.editor.getText()) this.editor.setText(text);
      this.controller.setNotice(errorText(error));
    }
    finally { if (!this.disposed) this.tui.requestRender(); }
  }

  private refresh(): void {
    if (this.disposed) return;
    const snapshot = this.controller.snapshot; const state = this.controller.state;
    const connection = this.controller.client.status;
    this.header.setText(startupHeader(this.theme(), this.keys));
    this.notices.clear(); this.activity.clear();
    const notice = (text: string, color: 'warning' | 'error' | 'muted' = 'muted') => {
      this.notices.addChild(new Text(this.theme().fg(color, uiText(text)), 1, 1));
    };
    if (connection !== 'ready') notice(`Daemon ${connection}. Use /reconnect to retry.`, 'warning');
    else if (state && state.status !== 'live') notice(`Session ${state.status}. Use /reconnect to retry.`, 'warning');
    else if (!snapshot) notice('No session attached. Use /new or /sessions.', 'warning');
    if (snapshot?.policy.pending) notice('Stricter approval policy pending.', 'warning');
    else if (snapshot?.policy.effective === 'acp-strict') notice('Approvals required.');
    if (snapshot?.queue.length) notice(`${snapshot.queue.length} queued`);
    try {
      const presentation = fallbackPresentations(snapshot?.presentation ?? [], this.options.hasRenderer);
      const hasPowerline = snapshot?.presentation.some(item => item.kind === 'view' && isPowerlinePresentation(item));
      for (const item of presentation) {
        if (item.kind === 'notification') notice(`${item.level === 'info' ? '' : item.level === 'warning' ? 'Warning: ' : 'Error: '}${item.text}`, item.level === 'info' ? 'muted' : item.level);
        else if (item.kind === 'status' && item.id !== 'working' && !hasPowerline) notice(statusText(item));
        else if (item.kind === 'progress') notice(`${item.label}: ${item.state}${item.fraction === undefined ? '' : ` (${Math.round(item.fraction * 100)}%)`}`);
      }
    } catch { notice('Extension status is unavailable.', 'warning'); }
    if (this.controller.notice) notice(this.controller.notice);
    const running = state?.status === 'live' && snapshot && !['idle', 'interrupted'].includes(snapshot.run.state);
    if (running) {
      const status = snapshot.presentation.find(item => item.kind === 'status' && item.id === 'working');
      const message = status?.kind === 'status' ? statusText(status) : 'Working';
      this.working ??= new Loader(this.tui, text => this.editor.borderColor(text), text => this.editor.borderColor(text), message, this.workingIndicator());
      this.working.setMessage(message);
      this.activity.addChild(this.working);
    } else { this.working?.stop(); this.working = undefined; }
    this.editor.disableSubmit = this.controller.busy;
    if (snapshot) {
      try {
        this.transcript.showProjection(projectTuiTranscript(snapshot, this.controller.history, this.options.settings?.() ?? {
          hideThinking: false, showImages: true, imageWidthCells: 60, outputPad: 1, toolMode: 'grouped',
        }));
      } catch (error) { notice(`Cannot render transcript: ${errorText(error)}`, 'error'); }
    }
    this.tui.requestRender();
  }

  private workingIndicator() {
    return { frames: WORKING_FRAMES.map(frame => this.theme().fg('accent', frame)), intervalMs: 120 };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true; this.working?.stop(); this.unsubscribe(); this.removeInput(); this.dialogs.dispose(); this.transcript.dispose();
    if (this.submitting) await this.submitting;
  }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function fallbackPresentations(presentation: readonly Presentation[], hasRenderer?: (element: Presentation) => boolean): readonly Presentation[] {
  return presentation.filter(element => !hasRenderer?.(element));
}
