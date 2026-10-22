import { PROCESSES_HINT } from './data.js';
import {
  uuidv7, type ExtensionUi, type UiActionContext, type UiActionRequest, type UiAction,
  type UiDocument, type UiElementHandle, type UiView,
} from '@felan-ai/agent-core';
import { parseUiPresentation, validateUiAction } from '@felan-ai/session-protocol';
import type { BackgroundBashJob, BackgroundBashPage, BackgroundBashQuery } from './job-store.js';
import type { BackgroundProcessViewSource } from './presentation.js';
import { processViewJob, splitProcessLog } from './data.js';

const PAGE_SIZE = 10;

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
    async refresh(): Promise<void> {
      if (disposed || !active || active.closed) return;
      await active.update();
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
  private history = false;
  private search = '';
  private pages: Array<{ cursor?: string; scannedBefore: number }> = [{ scannedBefore: 0 }];
  private pageIndex = 0;
  private page: BackgroundBashPage = { jobs: [], hasMore: false, scanned: 0 };
  private loading = false;
  private error = false;
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

  update(): Promise<void> {
    const operation = this.queue.then(async () => {
      if (!this.closed) await this.refresh();
    });
    this.queue = operation.catch(() => {});
    return operation;
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
      if (['previous', 'next', 'history', 'recent', 'search'].includes(action.actionId)) {
        const next = action.actionId === 'next';
        const index = next ? this.pageIndex + 1 : action.actionId === 'previous' ? this.pageIndex - 1 : 0;
        const pages = next ? [...this.pages.slice(0, index), {
          cursor: this.page.nextCursor!, scannedBefore: this.pages[this.pageIndex]!.scannedBefore + this.page.scanned,
        }] : action.actionId === 'previous' ? this.pages : [{ scannedBefore: 0 }];
        const search = action.actionId === 'search' ? ((action.values.query as string | undefined) ?? '').trim()
          : action.actionId === 'recent' || action.actionId === 'history' ? '' : this.search;
        const history = action.actionId === 'recent' ? false : action.actionId === 'history' || action.actionId === 'search' || this.history;
        await this.load({ history, search, pages, index }, context);
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
        this.view = undefined;
        await this.refresh(context);
      } else {
        const id = action.itemId ?? this.selected;
        if (!id) throw new Error('No process is selected.');
        const cursor = this.pages[this.pageIndex]!.cursor;
        const jobs = this.source.query ? (await this.source.query({ limit: PAGE_SIZE, search: id,
          ...(cursor ? { cursor } : {}),
        })).jobs : await this.source.list('all');
        this.assertOpen(context);
        const job = jobs.find(job => job.meta.id === id);
        if (!job) throw new Error('The process is no longer available in this view. Refresh and try again.');
        if (job.status.status !== 'running') throw new Error('The process is no longer running.');
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
    await this.load({ history: this.history, search: this.search, pages: this.pages, index: this.pageIndex }, context, !this.viewHandle || !!context);
    this.assertOpen(context);
    if (this.selected) {
      const index = this.jobs.findIndex(job => job.meta.id === this.selected);
      if (index < 0) this.selected = undefined;
      else {
        const output = await this.source.tail(this.selected, 2000);
        this.assertOpen(context);
        this.chunks = splitProcessLog(output);
        this.chunk = this.chunks.length - 1;
      }
    }
    await this.publish(context);
    if (!this.selected) await this.closeLog();
  }

  private async query(options: BackgroundBashQuery): Promise<BackgroundBashPage> {
    if (this.source.query) return this.source.query(options);
    const jobs = (await this.source.list('all')).filter(job => !options.search
      || `${job.meta.id}\n${job.meta.command}`.toLowerCase().includes(options.search.toLowerCase()));
    const offset = Number(options.cursor ?? 0);
    const rows = jobs.slice(offset, offset + PAGE_SIZE);
    const hasMore = offset + rows.length < jobs.length;
    return { jobs: rows, hasMore, scanned: rows.length, ...(hasMore ? { nextCursor: String(offset + rows.length) } : {}) };
  }

  private async load(target: { history: boolean; search: string; pages: Array<{ cursor?: string; scannedBefore: number }>; index: number },
    context?: UiActionContext, showLoading = true): Promise<void> {
    this.error = false;
    if (showLoading) { this.loading = true; await this.publish(context); }
    try {
      const cursor = target.pages[target.index]!.cursor;
      const page = await this.query({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}), ...(target.search ? { search: target.search } : {}) });
      this.assertOpen(context);
      this.history = target.history; this.search = target.search;
      this.pages = target.pages; this.pageIndex = target.index;
      this.page = page; this.jobs = page.jobs;
    } catch (error) {
      this.error = !context?.signal.aborted;
      this.loading = false;
      if (!this.closed && !this.signal.aborted) await this.publish();
      throw error;
    } finally { this.loading = false; }
  }

  private async publish(context?: UiActionContext): Promise<void> {
    try { await this.publishCurrent(context); }
    catch (error) { this.close(); throw error; }
  }

  private async publishCurrent(context?: UiActionContext): Promise<void> {
    this.assertOpen(context);
    const rows = this.jobs.map(processViewJob);
    const running = this.jobs.filter(job => job.status.status === 'running').length;
    const hasNext = this.history && this.page.hasMore && !!this.page.nextCursor;
    const scanned = this.pages[this.pageIndex]!.scannedBefore + this.page.scanned;
    const navigation: UiAction[] = [
      ...(this.pageIndex > 0 ? [{ id: 'previous', label: 'Previous processes', target: 'element' as const, outcome: 'submit' as const }] : []),
      ...(hasNext ? [{ id: 'next', label: rows.length ? 'Next processes' : 'Continue scanning', target: 'element' as const, outcome: 'submit' as const }] : []),
    ];
    const scope = this.search ? `Process search: ${plainText(this.search)}` : this.history ? 'Process history' : 'Recent processes';
    const view: UiView = {
      id: this.id, kind: 'view', hint: PROCESSES_HINT, revision: this.viewRevision + 1,
      title: `${scope} · ${rows.length} shown (${running} running on page)`,
      fallback: this.loading ? 'Loading processes…' : this.error ? 'Could not load processes. Refresh to retry, or choose a scope again.'
        : `${this.history ? `Page ${this.pageIndex + 1} · ${scanned} records scanned. ` : 'Newest 10. '}${!rows.length
          ? this.page.hasMore ? 'No matches in this batch; more history remains.' : this.search ? 'No matching processes.' : 'No background processes.'
          : this.page.hasMore ? 'More history available.' : 'End of history.'}`,
      fields: [{ id: 'command', label: 'Command', valueKind: 'text' }, { id: 'clipped', label: 'Command clipped', valueKind: 'boolean' },
        { id: 'status', label: 'State', valueKind: 'text' }, { id: 'started', label: 'Started (epoch ms)', valueKind: 'number' },
        { id: 'stdin', label: 'Interactive stdin', valueKind: 'boolean' }],
      items: rows.map(job => ({ id: job.id, values: { command: plainText(job.command), clipped: job.commandTruncated,
        status: job.status, started: job.startedAt, stdin: this.jobs.find(source => source.meta.id === job.id)?.meta.executionMode === 'pty' },
      fallback: `${job.id}: ${job.status}` })),
      actions: [{ id: 'read', label: 'Read output', target: 'item', outcome: 'submit' },
        ...navigation,
        { id: this.history ? 'recent' : 'history', label: this.history ? 'Recent 10' : 'Show all history', target: 'element', outcome: 'submit' },
        { id: 'search', label: 'Search all history', target: 'element', outcome: 'submit', input: { fields: [
          { id: 'query', label: 'Command or process ID (empty for all history)', kind: 'string', required: true, maxLength: 256 },
        ], defaults: { query: this.search } } },
        { id: 'refresh', label: 'Refresh', target: 'element', outcome: 'submit' },
        { id: 'close', label: 'Close process view', target: 'element', outcome: 'cancel' }],
      query: { actionId: 'search', values: { query: this.search } },
      ...(navigation.length ? { paging: {
        ...(this.pageIndex > 0 ? { previousActionId: 'previous' } : {}), ...(hasNext ? { nextActionId: 'next' } : {}),
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
    const job = this.jobs.find(job => job.meta.id === this.selected);
    if (!job) return;
    const controls: UiAction[] = job.status.status === 'running' ? [
      { id: 'stop', label: 'Stop process', target: 'element', outcome: 'submit', destructive: true },
      { id: 'kill', label: 'Kill process', target: 'element', outcome: 'submit', destructive: true },
      ...(job.meta.executionMode === 'pty' && this.source.write ? [{ id: 'write', label: 'Send exact stdin', target: 'element' as const, outcome: 'submit' as const,
        input: { fields: [{ id: 'chars', kind: 'string' as const, label: 'Exact text or control bytes', required: true, maxLength: 32 * 1024, multiline: true }] } }] : []),
    ] : [];
    const document: UiDocument = {
      id: this.logId, kind: 'document', hint: PROCESSES_HINT, revision: ++this.documentRevision, title: `Output: ${job.meta.id}`,
      fallback: `Output page ${this.chunk + 1} of ${this.chunks.length}; process ${job.status.status}.`,
      markdown: `State: ${job.status.status}\n\nCommand${processViewJob(job).commandTruncated ? ' (clipped)' : ''}: ${markdownText(processViewJob(job).command)}\n\nOutput page ${this.chunk + 1} of ${this.chunks.length}:\n\n${markdownText(this.chunks[this.chunk]!) || '(no output)'}`,
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
