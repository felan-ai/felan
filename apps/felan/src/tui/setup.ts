import { SetupCatalogSchema, SetupJobSchema, parseSchema, type Operation, type OperationParams, type OperationResult, type SetupCatalog, type SetupJob, type SetupStart } from '@felan-ai/session-protocol';
import type { TuiSessionController } from './controller.js';
import type { TerminalSetupUi } from './setup-ui.js';

const REQUIRED = ['host.setup.catalog', 'host.setup.start', 'host.setup.read', 'host.setup.answer', 'host.setup.cancel'] as const;
const POLL_MS = 500;
const REQUEST_MS = 15_000;
const MAX_DURATION_MS = 10 * 60_000;
const CANCEL_MS = 1_500;
type SetupOperation = Extract<Operation, `host.setup.${string}`>;
interface Flow { abort: AbortController; done: Promise<boolean>; job?: SetupJob; cancelling?: Promise<void> }
type Action = { kind: 'cancel' } | { kind: 'answer'; promptId: string; text: string } | { kind: 'link'; index: number };

export class TerminalSetup {
  private active: Flow | undefined;
  private closed = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly controller: TuiSessionController, private readonly ui: TerminalSetupUi) {}

  login(): Promise<boolean> { return this.run(false, flow => this.loginFlow(flow)); }
  dependencies(automatic = false): Promise<boolean> { return this.run(automatic, flow => this.dependenciesFlow(flow, automatic)); }
  get busy(): boolean { return this.active !== undefined; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  private run(automatic: boolean, work: (flow: Flow) => Promise<boolean>): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.active) {
      if (!automatic) this.controller.setNotice('A setup dialog is already open. Finish or cancel it first.');
      return Promise.resolve(false);
    }
    if (!this.ui.isIdle()) {
      if (!automatic) this.controller.setNotice('Finish the current dialog before starting setup.');
      return Promise.resolve(false);
    }
    const missing = REQUIRED.filter(op => !this.controller.client.capabilities?.operations.includes(op));
    if (missing.length) {
      if (!automatic) this.controller.setNotice('This daemon does not support interactive setup. Upgrade or restart it before using /login or /dependencies.');
      return Promise.resolve(false);
    }
    const flow: Flow = { abort: new AbortController(), done: Promise.resolve(false) };
    this.active = flow; this.emit();
    const deadline = setTimeout(() => flow.abort.abort(new Error('Setup timed out.')), MAX_DURATION_MS);
    flow.done = work(flow).catch(() => {
      if (!this.closed) this.controller.setNotice(flow.abort.signal.aborted ? 'Setup cancelled or timed out.' : 'Setup could not be completed. Retry /login or /dependencies.');
      return false;
    }).finally(async () => {
      clearTimeout(deadline); flow.abort.abort();
      await this.cancel(flow);
      if (this.active === flow) { this.active = undefined; this.emit(); }
    });
    return flow.done;
  }

  private async catalog(flow: Flow): Promise<SetupCatalog> {
    const result = parseSchema(SetupCatalogSchema, await this.request('host.setup.catalog', {}, flow.abort.signal));
    if (new Set(result.providers.map(value => value.id)).size !== result.providers.length
      || new Set(result.dependencies.map(value => value.id)).size !== result.dependencies.length) throw new Error('Duplicate setup catalog IDs.');
    return result;
  }

  private async loginFlow(flow: Flow): Promise<boolean> {
    const catalog = await this.catalog(flow); const signal = flow.abort.signal;
    if (!catalog.providers.length) { this.controller.setNotice('The daemon has no login providers available.'); return false; }
    const selected = await this.ui.select('Log in through the daemon', catalog.providers.map(provider => ({ value: provider.id, label: provider.label,
      description: provider.configured ? 'Already configured; continue to replace credentials' : 'Not configured' })), { signal });
    if (selected === undefined || signal.aborted) return false;
    const provider = catalog.providers.find(value => value.id === selected); if (!provider) return false;
    const method = await this.ui.select(`Login method · ${provider.label}`, provider.methods.map(value => ({ value,
      label: value === 'oauth' ? 'OAuth · authorize in the daemon browser' : 'API key · secure input' })), { signal });
    if (method === undefined || signal.aborted || !provider.methods.includes(method as 'oauth' | 'api_key')) return false;
    if (!await this.ui.confirm('Start login', `Let the daemon configure ${provider.label}${provider.configured ? ' and replace its existing credentials' : ''}?`, { signal })) return false;
    return this.start(flow, { kind: 'login', provider: provider.id, method: method as 'oauth' | 'api_key', confirmed: true });
  }

  private async dependenciesFlow(flow: Flow, automatic: boolean): Promise<boolean> {
    const catalog = await this.catalog(flow); const signal = flow.abort.signal;
    const dependencies = catalog.dependencies.filter(value => !automatic || value.needsSetup);
    if (!dependencies.length) {
      if (!automatic) this.controller.setNotice('No optional dependencies require configuration.');
      return false;
    }
    if (automatic && !this.ui.isIdle()) return false;
    const actionFor = (value: SetupCatalog['dependencies'][number]): 'install' | 'enable' | 'disable' | 'skip' =>
      !value.available && value.installable ? 'install' : value.available && !value.enabled ? 'enable' : value.enabled ? 'disable' : 'skip';
    const selected = await this.ui.checklist(dependencies.map(value => ({ id: value.id,
      label: `${actionFor(value)}: ${value.label}${value.version ? ` (${value.version})` : ''}`,
      description: `${value.description}${value.reason ? ` ${value.reason}` : ''} Checked: ${actionFor(value)}. Unchecked: use the safe fallback.` })), signal);
    if (selected === undefined || signal.aborted) return false;
    if (selected.some(id => !dependencies.some(value => value.id === id))) throw new Error('Unknown dependency choice.');
    return this.start(flow, { kind: 'dependencies', confirmed: true,
      choices: dependencies.map(value => ({ id: value.id, action: selected.includes(value.id) ? actionFor(value) : 'skip' })) });
  }

  private async start(flow: Flow, params: SetupStart): Promise<boolean> {
    const job = parseSchema(SetupJobSchema, await this.request('host.setup.start', params, flow.abort.signal, result => {
      if (flow.abort.signal.aborted) {
        try { flow.job = parseSchema(SetupJobSchema, result); void this.cancel(flow); } catch { /* An invalid late reply cannot identify a cancellable job. */ }
      }
    }));
    flow.job = job;
    if (job.kind !== params.kind) throw new Error('Setup job kind changed.');
    return this.monitor(flow);
  }

  private async monitor(flow: Flow): Promise<boolean> {
    const signal = flow.abort.signal;
    let read: Promise<{ kind: 'read'; job: SetupJob }> | undefined;
    let view: { key: string; abort: AbortController; result: Promise<{ kind: 'action'; value: Action }> } | undefined;
    let answered: string | undefined;
    try {
      while (!signal.aborted) {
        const job = flow.job!;
        if (terminal(job)) {
          this.controller.setNotice(`${job.kind === 'login' ? 'Login' : 'Dependency setup'} ${job.state}.`);
          return job.state === 'completed';
        }
        const key = JSON.stringify([job.state, job.prompt, job.links, job.prompt?.id === answered, job.prompt ? '' : job.message]);
        if (!view || view.key !== key) {
          view?.abort.abort();
          const abort = new AbortController();
          view = { key, abort, result: this.present(job, abort.signal, answered).then(value => ({ kind: 'action' as const, value })) };
        }
        read ??= delay(POLL_MS, signal).then(async () => ({ kind: 'read' as const,
          job: parseSchema(SetupJobSchema, await this.request('host.setup.read', { jobId: job.id }, signal)) }));
        const event = await interruptible(Promise.race([view.result, read]), signal);
        if (event.kind === 'read') {
          read = undefined;
          if (event.job.id !== job.id || event.job.kind !== job.kind) throw new Error('Setup job identity changed.');
          flow.job = event.job;
          continue;
        }
        view.abort.abort(); view = undefined;
        if (event.value.kind === 'cancel') { this.controller.setNotice('Setup cancellation requested.'); return false; }
        if (event.value.kind === 'link') {
          await this.request('host.setup.open_link', { jobId: job.id, index: event.value.index, confirmed: true }, signal);
        } else {
          if (event.value.promptId !== job.prompt?.id) continue;
          if (Buffer.byteLength(event.value.text, 'utf8') > 64 * 1024) {
            this.controller.setNotice('Setup response is too long. Enter at most 64 KiB.'); continue;
          }
          await this.request('host.setup.answer', { jobId: job.id, promptId: event.value.promptId, text: event.value.text }, signal);
          answered = event.value.promptId;
        }
      }
      return false;
    } finally { view?.abort.abort(); void read?.catch(() => {}); }
  }

  private async present(job: SetupJob, signal: AbortSignal, answered?: string): Promise<Action> {
    const canOpen = !!job.links?.length && this.controller.client.capabilities?.operations.includes('host.setup.open_link');
    if (job.state === 'waiting' && job.prompt && job.prompt.id !== answered) {
      if (canOpen) {
        const choice = await this.ui.select(job.message || 'Login authorization', [
          { value: 'respond', label: 'Enter the requested response' },
          ...job.links!.map((link, index) => ({ value: `link:${index}`, label: `Open ${link.label}`, description: link.url })),
          { value: 'cancel', label: 'Cancel setup' },
        ], { signal });
        if (signal.aborted || choice === undefined || choice === 'cancel') return { kind: 'cancel' };
        if (choice.startsWith('link:')) return this.confirmLink(job, Number(choice.slice(5)), signal);
        if (choice !== 'respond') return { kind: 'cancel' };
      }
      const prompt = job.prompt;
      const text = prompt.kind === 'select'
        ? await this.ui.select(prompt.message, prompt.choices.map(value => ({ value: value.id, label: value.label,
          ...(value.description ? { description: value.description } : {}) })), { signal })
        : await this.ui.input(prompt.message, '', { signal, secret: prompt.secret, ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}) });
      if (text === undefined || signal.aborted) return { kind: 'cancel' };
      if (prompt.kind === 'select' && !prompt.choices.some(value => value.id === text)) return { kind: 'cancel' };
      return { kind: 'answer', promptId: prompt.id, text };
    }
    if (await this.ui.progress({ ...job, ...(canOpen ? {} : { links: [] }) }, signal) !== 'links' || signal.aborted) return { kind: 'cancel' };
    const selected = await this.ui.select('Open a setup link through the daemon', job.links!.map((link, index) => ({ value: String(index), label: link.label, description: link.url })), { signal });
    if (selected === undefined || signal.aborted) return { kind: 'cancel' };
    return this.confirmLink(job, Number(selected), signal);
  }

  private async confirmLink(job: SetupJob, index: number, signal: AbortSignal): Promise<Action> {
    const link = job.links?.[index];
    if (!link || !await this.ui.confirm('Open in the daemon browser', link.url, { signal }) || signal.aborted) return { kind: 'cancel' };
    return { kind: 'link', index };
  }

  private async request<O extends SetupOperation>(op: O, params: OperationParams<O>, signal: AbortSignal,
    received?: (result: OperationResult<O>) => void): Promise<OperationResult<O>> {
    if (signal.aborted) throw new Error('Setup cancelled.');
    if (!this.controller.client.capabilities?.operations.includes(op)) throw new Error('Setup operation is unavailable.');
    const pending = this.controller.client.request(op, params).then(response => {
      if (response.outcome !== 'accepted') throw new Error('Setup request was not accepted.');
      received?.(response.result); return response.result;
    });
    return interruptible(pending, signal, REQUEST_MS);
  }

  private cancel(flow: Flow): Promise<void> {
    if (!flow.job || terminal(flow.job)) return Promise.resolve();
    return flow.cancelling ??= (async () => {
      try {
        const response = await interruptible(this.controller.client.request('host.setup.cancel', { jobId: flow.job!.id }), undefined, CANCEL_MS);
        if (response.outcome !== 'accepted') throw new Error('Setup cancellation was not accepted.');
      }
      catch { if (!this.closed) this.controller.setNotice('Setup cancellation could not be confirmed. The daemon will also cancel it when this client disconnects.'); }
    })();
  }

  async dispose(): Promise<void> {
    this.closed = true;
    const active = this.active; active?.abort.abort();
    await active?.done;
    this.listeners.clear();
  }

  private emit(): void { for (const listener of this.listeners) listener(); }
}

function terminal(job: SetupJob): boolean { return job.state === 'completed' || job.state === 'cancelled' || job.state === 'failed'; }

function interruptible<T>(pending: Promise<T>, signal?: AbortSignal, timeout?: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new Error('Setup cancelled or timed out.')); };
    signal?.addEventListener('abort', abort, { once: true });
    if (timeout !== undefined) timer = setTimeout(abort, timeout);
    void pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal?.aborted) abort();
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('Setup cancelled.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
  });
}
