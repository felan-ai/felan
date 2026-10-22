import { decodeUiMarkdown } from '../../../client/ui.js';
import type { UiDocument, UiView } from '@felan-ai/session-protocol';
import type { ExtensionContext } from '@felan-ai/agent-core';
import { matchesKey, stripTerminalSequences, truncateToWidth } from '@earendil-works/pi-tui';
import { PROCESS_VIEW_PAGE_SIZE, parseProcessViewRequest, processViewAction,
  type ProcessViewAction, type ProcessViewRequest } from '@felan-ai/ext-background-bash/data';

type Theme = ExtensionContext['ui']['theme'];
export interface ProcessViewNavigation { selectedId?: string; detailKey?: string; scroll: number; scope?: string }

function elementScope(source: UiView | UiDocument): string {
  return source.kind === 'view' ? JSON.stringify([source.query?.values, source.actions.some(action => action.id === 'recent')]) : source.id;
}

export class ProcessViewPanel {
  private selected: number;
  private scroll: number;
  private closed = false;
  private lines: string[];
  private readonly state!: ProcessViewRequest;
  constructor(state: ProcessViewRequest | undefined, private readonly theme: Theme,
    private readonly finish: (action: ProcessViewAction) => void, private readonly redraw: () => void,
    navigation?: ProcessViewNavigation,
    private readonly element?: { source: UiView | UiDocument; action(id?: string, itemId?: string): void; dismiss(): void }) {
    if (element) {
      this.selected = element.source.kind === 'view' && (!navigation?.scope || navigation.scope === elementScope(element.source))
        ? Math.max(0, element.source.items.findIndex(item => item.id === navigation?.selectedId)) : 0;
      this.scroll = navigation?.scroll ?? 0; this.lines = []; return;
    }
    if (!state) throw new Error('Process state is required.');
    this.state = state;
    const restored = state.jobs.findIndex(job => job.id === navigation?.selectedId);
    this.selected = Math.max(0, restored < 0 ? state.jobs.findIndex(job => job.id === state.selectedId) : restored);
    this.lines = plain(state.detail?.text ?? '').split('\n');
    const detailKey = state.detail ? `${state.detail.id}:${state.detail.index}` : undefined;
    const initialScroll = state.detail?.index === 0 && state.detail.chunks > 1 ? 0 : this.lines.length - 28;
    this.scroll = Math.max(0, Math.min(detailKey && detailKey === navigation?.detailKey ? navigation.scroll : initialScroll, this.lines.length - 28));
  }
  get navigation(): ProcessViewNavigation {
    if (this.element) return { ...(this.element.source.kind === 'view' && this.element.source.items[this.selected] ? { selectedId: this.element.source.items[this.selected]!.id } : {}), scroll: this.scroll, scope: elementScope(this.element.source) };
    return { ...(this.state.jobs[this.selected] ? { selectedId: this.state.jobs[this.selected]!.id } : {}),
    ...(this.state.detail ? { detailKey: `${this.state.detail.id}:${this.state.detail.index}` } : {}), scroll: this.scroll }; }
  update(source: UiView | UiDocument): void {
    if (!this.element || this.closed) return;
    const selectedId = elementScope(source) === elementScope(this.element.source) ? this.navigation.selectedId : undefined;
    this.element.source = source;
    this.selected = source.kind === 'view' ? Math.max(0, source.items.findIndex(item => item.id === selectedId)) : 0;
    this.redraw();
  }
  dispose(): void { this.closed = true; }
  invalidate(): void {}
  private send(action: Parameters<typeof processViewAction>[1]): void {
    if (this.closed) return;
    this.closed = true;
    this.finish(processViewAction(this.state, action));
  }
  handleInput(key: string): void {
    if (this.closed) return;
    if (this.element) { this.handleElementInput(key); return; }
    if (key === 'q' || matchesKey(key, 'escape')) { this.send({ action: 'close' }); return; }
    const job = this.state.detail ? this.state.jobs.find(item => item.id === this.state.detail!.id) : this.state.jobs[this.selected];
    if (key === 's' || key === 'k') { if (job) this.send({ action: 'signal', id: job.id, signal: key === 's' ? 'SIGTERM' : 'SIGKILL' }); return; }
    if (key === 'r') { this.send({ action: 'refresh' }); return; }
    if (this.state.detail) {
      const detail = this.state.detail;
      if (matchesKey(key, 'left') || matchesKey(key, 'backspace')) { this.send({ action: 'list' }); return; }
      if (key === '[' && detail.index > 0) { this.send({ action: 'output', index: detail.index - 1 }); return; }
      if (key === ']' && detail.index + 1 < detail.chunks) { this.send({ action: 'output', index: detail.index + 1 }); return; }
      if (key === 'g' || matchesKey(key, 'home')) {
        if (detail.index) { this.send({ action: 'output', index: 0 }); return; } this.scroll = 0;
      } else if (key === 'G' || matchesKey(key, 'end')) {
        if (detail.index + 1 < detail.chunks) { this.send({ action: 'output', index: detail.chunks - 1 }); return; } this.scroll = this.lines.length;
      } else this.scroll += matchesKey(key, 'up') ? -1 : matchesKey(key, 'down') ? 1
        : matchesKey(key, 'ctrl+u') ? -28 : matchesKey(key, 'ctrl+d') ? 28 : 0;
      this.scroll = Math.max(0, Math.min(this.scroll, this.lines.length - 28)); this.redraw(); return;
    }
    if ((matchesKey(key, 'return') || matchesKey(key, 'right')) && job) { this.send({ action: 'detail', id: job.id }); return; }
    if (!this.state.jobs.length) return;
    const last = Math.floor((this.state.total - 1) / PROCESS_VIEW_PAGE_SIZE) * PROCESS_VIEW_PAGE_SIZE;
    if (key === 'g' || matchesKey(key, 'home')) {
      if (this.state.offset) { this.send({ action: 'page', offset: 0, select: 'first' }); return; } this.selected = 0;
    } else if (key === 'G' || matchesKey(key, 'end')) {
      if (this.state.offset !== last) { this.send({ action: 'page', offset: last, select: 'last' }); return; } this.selected = this.state.jobs.length - 1;
    } else {
      const delta = matchesKey(key, 'up') ? -1 : matchesKey(key, 'down') ? 1
        : matchesKey(key, 'ctrl+u') ? -PROCESS_VIEW_PAGE_SIZE : matchesKey(key, 'ctrl+d') ? PROCESS_VIEW_PAGE_SIZE : 0;
      const index = this.selected + delta;
      if (index < 0 && this.state.offset) { this.send({ action: 'page', offset: this.state.offset - PROCESS_VIEW_PAGE_SIZE, select: 'last' }); return; }
      if (index >= this.state.jobs.length && this.state.offset < last) { this.send({ action: 'page', offset: this.state.offset + PROCESS_VIEW_PAGE_SIZE, select: 'first' }); return; }
      this.selected = Math.max(0, Math.min(index, this.state.jobs.length - 1));
    }
    this.redraw();
  }
  private handleElementInput(key: string): void {
    const { source, action } = this.element!;
    if (key === 'q' || matchesKey(key, 'escape')) { this.element!.dismiss(); return; }
    const shortcuts: Record<string, string> = { r: 'refresh', s: 'stop', k: 'kill',
      '[': source.kind === 'document' ? 'previous-output' : 'previous',
      ']': source.kind === 'document' ? 'next-output' : 'next' };
    const id = source.kind === 'view' && matchesKey(key, 'ctrl+r') ? 'search'
      : source.kind === 'view' && key === 'h' ? source.actions.some(entry => entry.id === 'recent') ? 'recent' : 'history'
      : source.kind === 'view' && matchesKey(key, 'ctrl+d') ? 'next'
      : source.kind === 'view' && matchesKey(key, 'ctrl+u') ? 'previous' : shortcuts[key];
    if (key === 'a') { action(); return; }
    if (id && source.actions.some(entry => entry.id === id)) { action(id); return; }
    if (source.kind === 'document') {
      if (matchesKey(key, 'left') || matchesKey(key, 'backspace')) { action('list'); return; }
      this.scroll += matchesKey(key, 'up') ? -1 : matchesKey(key, 'down') ? 1 : matchesKey(key, 'ctrl+u') ? -28 : matchesKey(key, 'ctrl+d') ? 28 : 0;
      this.scroll = Math.max(0, Math.min(this.scroll, this.lines.length - 28));
    } else {
      if (matchesKey(key, 'home')) this.selected = 0;
      else if (matchesKey(key, 'end')) this.selected = Math.max(0, source.items.length - 1);
      else this.selected = Math.max(0, Math.min(this.selected + (matchesKey(key, 'up') ? -1 : matchesKey(key, 'down') ? 1 : 0), source.items.length - 1));
      if ((matchesKey(key, 'return') || matchesKey(key, 'right')) && source.items[this.selected]) {
        action('read', source.items[this.selected]!.id); return;
      }
    }
    this.redraw();
  }
  private renderElement(width: number): string[] {
    const source = this.element!.source;
    const lines = [this.theme.fg('accent', this.theme.bold(plain(source.title)))];
    if (source.kind === 'view') {
      lines.push(plain(source.fallback), '↑↓ select · enter output · r refresh · a actions · q/esc close');
      const shortcuts = [source.actions.some(entry => entry.id === 'search') ? 'ctrl+r search history' : '',
        source.actions.some(entry => entry.id === 'recent') ? 'h recent 10' : source.actions.some(entry => entry.id === 'history') ? 'h all history' : '',
        source.paging?.previousActionId ? '[ / ctrl+u previous' : '', source.paging?.nextActionId ? '] / ctrl+d next/scan' : ''].filter(Boolean);
      if (shortcuts.length) lines.push(shortcuts.join(' · '));
    } else lines.push('← list · ↑↓ scroll · ctrl+u/d page · [/] chunks · s stop · k kill · r refresh · a actions · q/esc close');
    if (source.kind === 'document') {
      this.lines = plain(decodeUiMarkdown(source.markdown, { plainText: true })).split('\n');
      lines.push(...this.lines.slice(this.scroll, this.scroll + 28));
    }
    else for (const [index, item] of source.items.entries()) {
      lines.push(plain(`${index === this.selected ? '▶' : ' '} ${item.id}  ${item.values.status}  ${item.values.command}${item.values.clipped ? '…' : ''}`));
    }
    const border = this.theme.fg('border', '─'.repeat(width));
    return [border, ...lines.map(line => truncateToWidth(line, width, '…')), border];
  }
  render(width: number): string[] {
    width = Math.max(1, Math.floor(width));
    const t = this.theme;
    if (this.element) return this.renderElement(width);
    const lines = [t.fg('accent', t.bold('Background processes'))];
    if (this.state.notice) lines.push(t.fg('warning', plain(this.state.notice)));
    if (this.state.detail) {
      const detail = this.state.detail; const job = this.state.jobs.find(item => item.id === detail.id)!;
      lines.push(`${job.id} · ${job.status}`, `command=${plain(job.command)}${job.commandTruncated ? '… [preview]' : ''}`,
        t.fg('dim', '← list · ↑↓ scroll · ctrl+u/d page · [ ] chunks · g/G top/bottom · s stop · k kill · r refresh · q close'),
        `Bounded tail · chunk ${detail.index + 1}/${detail.chunks}`,
        ...this.lines.slice(this.scroll, this.scroll + 28));
    } else {
      lines.push(`${this.state.running} running · ↑↓ select · enter open · s stop · k kill · r refresh · q close`,
        `Showing processes ${this.state.total ? this.state.offset + 1 : 0}-${this.state.offset + this.state.jobs.length}/${this.state.total}`);
      if (!this.state.jobs.length) lines.push('No background processes found for this workspace.');
      this.state.jobs.forEach((job, index) => {
        const duration = Math.max(0, Math.floor(((job.completedAt ?? (job.status === 'running' ? Date.now() : job.updatedAt)) - job.startedAt) / 1000));
        lines.push(`${index === this.selected ? '▶' : ' '} ${job.id}  ${job.status}  ${duration}s  ${plain(job.command).replace(/\n/g, ' ')}${job.commandTruncated ? '…' : ''}`);
      });
    }
    const border = t.fg('border', '─'.repeat(width));
    return [border, ...lines.map(line => truncateToWidth(line, width, '…')), border];
  }
}

export async function presentProcessView(ui: Pick<ExtensionContext['ui'], 'custom'>, value: ProcessViewRequest,
  signal: AbortSignal, navigation?: ProcessViewNavigation): Promise<{ action?: ProcessViewAction; navigation?: ProcessViewNavigation }> {
  const state = parseProcessViewRequest(value);
  if (signal.aborted) return {};
  let panel: ProcessViewPanel | undefined; let finish: ((value: ProcessViewAction | undefined) => void) | undefined;
  const abort = () => { panel?.dispose(); finish?.(undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const action = await ui.custom<ProcessViewAction | undefined>((tui, theme, _keys, done) => {
      finish = done; panel = new ProcessViewPanel(state, theme, done, () => tui.requestRender(), navigation);
      if (signal.aborted) abort();
      return panel;
    });
    return { ...(action ? { action } : {}), ...(panel ? { navigation: panel.navigation } : {}) };
  } finally { signal.removeEventListener('abort', abort); panel?.dispose(); }
}

function plain(value: string): string { return stripTerminalSequences(value).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu, ''); }

