import type { Theme } from '@earendil-works/pi-coding-agent';
import { Container, Editor, getKeybindings, ScrollView, Text, VStack, stripTerminalSequences, type Component, type TUI } from '@earendil-works/pi-tui';
import type { AgentViewTranscript } from '@felan-ai/ext-subagents/view';
import { AgentTranscript, type AgentToolPresentation } from '../subagents/agent-transcript.js';
import { TuiSessionController } from './controller.js';
import { projectTuiTranscript } from './transcript.js';
import { TuiDialogs } from './dialogs.js';
import { createCommandAutocomplete, submitTuiInput, type DaemonAction } from './commands.js';
import { runtimeUiState } from '../client/presenters.js';
import { clientSelectListTheme, defaultClientTheme } from './theme.js';

export class DaemonTuiScreen {
  readonly editor: Editor;
  readonly transcript: AgentTranscript;
  readonly scroll: ScrollView;
  readonly component: Component;
  readonly dialogs: TuiDialogs;
  private readonly status = new Text('', 0, 0);
  private readonly header = new Text('Felan · connecting', 0, 0);
  private readonly footer = new Container();
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
    login?(): Promise<boolean>;
    dependencies?(): Promise<boolean>;
    settings?: () => AgentViewTranscript['settings'];
    toolPresentation?: (name: string) => AgentToolPresentation | undefined;
    theme?: () => Theme;
  }) {
    const initialTheme = options.theme ? undefined : defaultClientTheme();
    const theme = options.theme ?? (() => initialTheme!);
    const selectList = clientSelectListTheme(theme);
    this.dialogs = new TuiDialogs(tui, theme);
    this.editor = new Editor(tui, { borderColor: selectList.scrollInfo, selectList });
    this.editor.setAutocompleteProvider(createCommandAutocomplete(controller));
    this.transcript = new AgentTranscript(tui, this.keys, options.toolPresentation, theme);
    this.scroll = new ScrollView(this.transcript, { follow: 'end', primary: true, scrollbar: 'auto' });
    const stack = new VStack([this.header, { component: this.scroll, grow: 1, minSize: 0 }, this.status,
      { component: this.editor, maxSize: 10 }, this.footer]);
    this.component = stack;
    this.editor.onSubmit = text => {
      this.editor.setText(text);
      if (this.submitting) this.queuedSubmit = text;
      else this.trackSubmission(this.submit(text));
    };
    this.removeInput = tui.addInputListener(data => {
      if (tui.hasOverlay()) return undefined;
      if (this.keys.matches(data, 'app.exit') && !this.editor.getText()) { options.exit(); return { consume: true }; }
      if (this.keys.matches(data, 'app.interrupt')) { void controller.cancel().catch(error => controller.setNotice(errorText(error))); return { consume: true }; }
      if (this.keys.matches(data, 'app.clear')) { this.editor.setText(''); tui.requestRender(); return { consume: true }; }
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
        if (text && !this.submitting) this.trackSubmission(controller.submit(text, 'follow_up').then(accepted => {
          if (accepted && this.editor.getExpandedText() === text) { this.editor.addToHistory(text); this.editor.setText(''); }
        }).catch(error => controller.setNotice(errorText(error))).finally(() => { tui.requestRender(); }));
        return { consume: true };
      }
      if (this.transcript.handleInput(data)) return { consume: true };
      return undefined;
    });
    this.unsubscribe = controller.subscribe(() => this.refresh()); this.refresh();
  }

  focus(): void { this.tui.setFocus(this.editor); }
  refreshPresentation(): void { this.component.invalidate(); this.refresh(); this.tui.requestRender(true); }
  setFooter(component?: Component): void {
    this.footer.clear(); if (component) this.footer.addChild(component); this.tui.requestRender();
  }

  private action(command: string): void {
    if (!this.submitting) this.trackSubmission(this.submit(command, true));
  }

  private trackSubmission(pending: Promise<void>): void {
    this.submitting = pending.finally(() => {
      this.submitting = undefined;
      const text = this.queuedSubmit; this.queuedSubmit = undefined;
      if (!this.disposed && text !== undefined && this.editor.getExpandedText() === text) this.trackSubmission(this.submit(text));
    });
  }

  async submit(text: string, preserveDraft = false): Promise<void> {
    if (!preserveDraft && !this.editor.getText()) this.editor.setText(text);
    try {
      if (await submitTuiInput(this.controller, this.dialogs, text, { ...this.options, setDraft: value => this.editor.setText(value) })) {
        if (!preserveDraft) {
          this.editor.addToHistory(text);
          if (this.editor.getText() === text) this.editor.setText('');
          this.scroll.scrollToEnd();
        }
      }
    } catch (error) { this.controller.setNotice(errorText(error)); }
    finally { if (!this.disposed) this.tui.requestRender(); }
  }

  private refresh(): void {
    if (this.disposed) return;
    const snapshot = this.controller.snapshot; const state = this.controller.state;
    const connection = this.controller.client.status;
    this.header.setText(stripTerminalSequences(`Felan · ${connection} · daemon ${this.controller.client.capabilities?.daemonVersion ?? 'unavailable'}${snapshot ? ` · ${snapshot.title || snapshot.session} · ${snapshot.cwd}` : ''}`));
    const policy = snapshot?.policy.pending ? ' · stricter approval policy pending' : snapshot?.policy.effective === 'acp-strict' ? ' · approvals required' : '';
    const status = `${state?.status ?? connection}${snapshot ? ` · ${snapshot.run.state} · ${snapshot.model.provider}/${snapshot.model.id} · ${snapshot.thinking}` : ''}${policy}`;
    const queue = snapshot?.queue.length ? ` · ${snapshot.queue.length} queued` : '';
    const extra: string[] = [];
    try {
      const presentation = snapshot?.presentation ?? [];
      const runtime = presentation.map(runtimeUiState).find(Boolean);
      if (runtime?.workingVisible !== false && runtime?.workingMessage) extra.push(runtime.workingMessage);
      extra.push(...presentation.flatMap(item => item.kind === 'status' ? [item.text] : []).slice(0, 8));
      extra.push(...presentation.flatMap(item => item.kind === 'notification' ? [`${item.level}: ${item.text}`] : []).slice(-2));
    } catch { extra.push('Extension status is unavailable.'); }
    const details = stripTerminalSequences(extra.join(' · ')).replace(/[\r\n]+/gu, ' ').slice(0, 2048);
    this.status.setText(stripTerminalSequences(`${status}${queue}${details ? `\n${details}` : ''}\n${this.controller.notice || 'Enter send · Shift+Enter newline · Esc cancel run · Ctrl+D detach'}`));
    this.editor.disableSubmit = this.controller.busy;
    if (snapshot) {
      try {
        this.transcript.showProjection(projectTuiTranscript(snapshot, this.controller.history, this.options.settings?.() ?? {
          hideThinking: false, showImages: true, imageWidthCells: 60, outputPad: 1, toolMode: 'grouped',
        }));
      } catch (error) { this.status.setText(`${status}\nCannot render transcript: ${stripTerminalSequences(errorText(error))}`); }
    }
    this.tui.requestRender();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true; this.unsubscribe(); this.removeInput(); this.dialogs.dispose(); this.transcript.dispose();
    if (this.submitting) await this.submitting;
  }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
