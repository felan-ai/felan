import { PROCESSES_HINT } from './data.js';
import {
  uuidv7, type ExtensionUi, type UiActionContext, type UiActionRequest, type UiAction,
  type UiDocument, type UiElementHandle, type UiView,
} from '@felan-ai/agent-core';
import { parseUiPresentation, validateUiAction } from '@felan-ai/session-protocol';
import type { BackgroundBashJob } from './job-store.js';
import type { BackgroundProcessViewSource } from './presentation.js';
import { parseProcessViewRequest, PROCESS_VIEW_PAGE_SIZE, processViewJob, splitProcessLog } from './data.js';


export function createCommonProcessPresentation(ui: ExtensionUi) {
  let active: ProcessUiView | undefined;
  let opening: Promise<void> | undefined;
  let disposed = false;
  return {
    async show(source: BackgroundProcessViewSource, signal: AbortSignal): Promise<void> {
      if (disposed) throw new Error('Process presentation is disposed.');
      if (opening || active && !active.closed) throw new Error('A process view is already open.');
      opening = (async () => {
        await active?.dispose();
        if (disposed) throw new Error('Process presentation is disposed.');
        const view = new ProcessUiView(ui, source, signal);
        active = view;
        await view.open();
      })();
      try { await opening; } finally { opening = undefined; }
    },
    async dispose(): Promise<void> {
      disposed = true;
      const cleanup = active?.dispose();
      await Promise.allSettled([opening, cleanup]);
      await cleanup;
    },
  };
}

class ProcessUiView {
  closed = false;
  private readonly id = `processes-${uuidv7()}`;
  private readonly logId = `${this.id}-log`;
  private viewRevision = 0;
  private documentRevision = 0;
  private jobs: BackgroundBashJob[] = [];
  private offset = 0;
  private selected: string | undefined;
  private chunks = [''];
  private chunk = 0;
  private view: UiView | undefined;
  private document: UiDocument | undefined;
  private viewHandle: UiElementHandle | undefined;
  private logHandle: UiElementHandle | undefined;
  private opening: Promise<void> = Promise.resolve();
  private queue: Promise<void> = Promise.resolve();
  private cleanup: Promise<void> | undefined;
  private readonly abort = () => this.close();

  constructor(private readonly ui: ExtensionUi, private readonly source: BackgroundProcessViewSource, private readonly signal: AbortSignal) {
    signal.addEventListener('abort', this.abort, { once: true });
  }

  async open(): Promise<void> {
    this.opening = this.refresh();
    this.queue = this.opening.catch(() => {});
    try { await this.opening; }
    catch (error) { await this.dispose(); throw error; }
  }

  private assertOpen(context?: UiActionContext): void {
    if (this.closed) throw new Error('Process view is closed.');
    this.signal.throwIfAborted();
    context?.signal.throwIfAborted();
  }

  private close(): void {
    this.closed = true;
    this.signal.removeEventListener('abort', this.abort);
    void this.dispose().catch(() => {});
  }

  dispose(): Promise<void> {
    this.closed = true;
    this.signal.removeEventListener('abort', this.abort);
    this.cleanup ??= (async () => {
      await Promise.allSettled([this.opening, this.queue]);
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.viewHandle?.close()), Promise.resolve().then(() => this.logHandle?.close()),
      ]);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Process view cleanup failed.');
    })();
    return this.cleanup;
  }

  private dispatch = (request: UiActionRequest, context: UiActionContext): Promise<void> => {
    const operation = this.queue.then(async () => {
      this.assertOpen(context);
      const source = request.elementId === this.id ? this.view : request.elementId === this.logId ? this.document : undefined;
      if (!source) throw new Error('Unknown process view element.');
      const action = validateUiAction(source, request);
      if (action.actionId === 'close') { this.close(); return; }
      if (action.actionId === 'previous' || action.actionId === 'next') {
        this.offset += action.actionId === 'previous' ? -PROCESS_VIEW_PAGE_SIZE : PROCESS_VIEW_PAGE_SIZE;
        this.selected = undefined;
        await this.publish(context);
        await this.closeLog();
      } else if (action.actionId === 'previous-output' || action.actionId === 'next-output') {
        this.chunk += action.actionId === 'previous-output' ? -1 : 1;
        await this.publish(context);
      } else if (action.actionId === 'list') {
        this.selected = undefined;
        this.view = undefined;
        await this.publish(context);
        await this.closeLog();
      } else if (action.actionId === 'read') {
        const selected = action.itemId!;
        const output = await this.source.tail(selected, 2000);
        this.assertOpen(context);
        this.selected = selected;
        this.chunks = splitProcessLog(output);
        this.chunk = this.chunks.length - 1;
        await this.publish(context);
      } else if (action.actionId === 'refresh') {
        await this.refresh(context);
      } else {
        const id = action.itemId ?? this.selected;
        const jobs = await this.source.list('all');
        this.assertOpen(context);
        const job = jobs.find(job => job.meta.id === id);
        if (!job || job.status.status !== 'running') throw new Error('The process is no longer running.');
        if (action.actionId === 'write') {
          if (!this.source.write || job.meta.executionMode !== 'pty') throw new Error('Process stdin is unavailable.');
          await this.source.write(job.meta.id, action.values.chars as string);
        } else if (action.actionId === 'stop' || action.actionId === 'kill') {
          await this.source.stop(job.meta.id, action.actionId === 'stop' ? 'SIGTERM' : 'SIGKILL');
        } else throw new Error('Unknown process control.');
        this.assertOpen(context);
        await this.refresh(context);
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  };

  private async closeLog(): Promise<void> {
    this.document = undefined;
    const handle = this.logHandle;
    if (handle) { await handle.close(); this.logHandle = undefined; }
  }

  private async refresh(context?: UiActionContext): Promise<void> {
    this.assertOpen(context);
    this.jobs = await this.source.list('all');
    this.assertOpen(context);
    if (this.selected) {
      const index = this.jobs.findIndex(job => job.meta.id === this.selected);
      if (index < 0) this.selected = undefined;
      else {
        this.offset = Math.floor(index / PROCESS_VIEW_PAGE_SIZE) * PROCESS_VIEW_PAGE_SIZE;
        const output = await this.source.tail(this.selected, 2000);
        this.assertOpen(context);
        this.chunks = splitProcessLog(output);
        this.chunk = this.chunks.length - 1;
      }
    }
    await this.publish(context);
    if (!this.selected) await this.closeLog();
  }

  private async publish(context?: UiActionContext): Promise<void> {
    try { await this.publishCurrent(context); }
    catch (error) { this.close(); throw error; }
  }

  private async publishCurrent(context?: UiActionContext): Promise<void> {
    this.assertOpen(context);
    this.offset = Math.min(this.offset, Math.max(0, Math.floor((this.jobs.length - 1) / PROCESS_VIEW_PAGE_SIZE) * PROCESS_VIEW_PAGE_SIZE));
    const request = parseProcessViewRequest({
      viewId: this.id, sequence: this.viewRevision + 1, offset: this.offset, total: this.jobs.length,
      running: this.jobs.filter(job => job.status.status === 'running').length,
      jobs: this.jobs.slice(this.offset, this.offset + PROCESS_VIEW_PAGE_SIZE).map(processViewJob),
      ...(this.selected ? { selectedId: this.selected, detail: { id: this.selected, index: this.chunk, chunks: this.chunks.length, text: this.chunks[this.chunk]! } } : {}),
    });
    const first = this.offset + 1;
    const last = this.offset + request.jobs.length;
    const navigation: UiAction[] = [
      ...(this.offset > 0 ? [{ id: 'previous', label: 'Previous processes', target: 'element' as const, outcome: 'submit' as const }] : []),
      ...(last < request.total ? [{ id: 'next', label: 'Next processes', target: 'element' as const, outcome: 'submit' as const }] : []),
    ];
    const view: UiView = {
      id: this.id, kind: 'view', hint: PROCESSES_HINT, revision: this.viewRevision + 1,
      title: request.total ? `Processes ${first}–${last} of ${request.total} (${request.running} running)` : 'No background processes',
      fallback: `${request.total} background processes; ${request.running} running. Read logs or refresh the list.`,
      fields: [{ id: 'command', label: 'Command', valueKind: 'text' }, { id: 'clipped', label: 'Command clipped', valueKind: 'boolean' },
        { id: 'status', label: 'State', valueKind: 'text' }, { id: 'started', label: 'Started (epoch ms)', valueKind: 'number' },
        { id: 'stdin', label: 'Interactive stdin', valueKind: 'boolean' }],
      items: request.jobs.map(job => ({ id: job.id, values: { command: plainText(job.command), clipped: job.commandTruncated,
        status: job.status, started: job.startedAt, stdin: this.jobs.find(source => source.meta.id === job.id)?.meta.executionMode === 'pty' },
      fallback: `${job.id}: ${job.status}` })),
      actions: [{ id: 'read', label: 'Read output', target: 'item', outcome: 'submit' },
        ...navigation, { id: 'refresh', label: 'Refresh', target: 'element', outcome: 'submit' },
        { id: 'close', label: 'Close process view', target: 'element', outcome: 'cancel' }],
      ...(navigation.length ? { paging: {
        ...(this.offset > 0 ? { previousActionId: 'previous' } : {}), ...(last < request.total ? { nextActionId: 'next' } : {}),
      } } : {}),
    };
    parseUiPresentation(view);
    if (!this.viewHandle || JSON.stringify({ ...view, revision: 0 }) !== JSON.stringify({ ...this.view, revision: 0 })) {
      this.viewRevision++;
      this.view = view;
      if (this.viewHandle) await this.viewHandle.update(view);
      else this.viewHandle = await this.ui.present(view, { signal: this.signal, onAction: this.dispatch });
    }
    this.assertOpen(context);
    if (!request.detail) return;
    const job = this.jobs.find(job => job.meta.id === request.detail!.id)!;
    const controls: UiAction[] = job.status.status === 'running' ? [
      { id: 'stop', label: 'Stop process', target: 'element', outcome: 'submit', destructive: true },
      { id: 'kill', label: 'Kill process', target: 'element', outcome: 'submit', destructive: true },
      ...(job.meta.executionMode === 'pty' && this.source.write ? [{ id: 'write', label: 'Send exact stdin', target: 'element' as const, outcome: 'submit' as const,
        input: { fields: [{ id: 'chars', kind: 'string' as const, label: 'Exact text or control bytes', required: true, maxLength: 32 * 1024, multiline: true }] } }] : []),
    ] : [];
    const document: UiDocument = {
      id: this.logId, kind: 'document', hint: PROCESSES_HINT, revision: ++this.documentRevision, title: `Output: ${request.detail.id}`,
      fallback: `Output page ${this.chunk + 1} of ${this.chunks.length}; process ${job.status.status}.`,
      markdown: `State: ${job.status.status}\n\nCommand${request.jobs.find(row => row.id === job.meta.id)?.commandTruncated ? ' (clipped)' : ''}: ${markdownText(processViewJob(job).command)}\n\nOutput page ${this.chunk + 1} of ${this.chunks.length}:\n\n${markdownText(request.detail.text) || '(no output)'}`,
      actions: [{ id: 'list', label: 'Back to processes', target: 'element', outcome: 'submit' },
        ...(this.chunk > 0 ? [{ id: 'previous-output', label: 'Previous output', target: 'element' as const, outcome: 'submit' as const }] : []),
        ...(this.chunk + 1 < this.chunks.length ? [{ id: 'next-output', label: 'Next output', target: 'element' as const, outcome: 'submit' as const }] : []),
        { id: 'refresh', label: 'Refresh output', target: 'element', outcome: 'submit' }, ...controls,
        { id: 'close', label: 'Close process view', target: 'element', outcome: 'cancel' }],
    };
    parseUiPresentation(document);
    this.document = document;
    if (this.logHandle) await this.logHandle.update(document);
    else this.logHandle = await this.ui.present(document, { signal: this.signal, onAction: this.dispatch });
    this.assertOpen(context);
  }
}

function plainText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function markdownText(value: string): string {
  return plainText(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|~\-]/gu, '\\$&');
}

export { PROCESSES_HINT } from './data.js';
