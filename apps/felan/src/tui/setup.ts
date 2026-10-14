import { SetupCatalogSchema, SetupJobSchema, parseSchema, type Operation, type OperationParams, type OperationResult, type SetupCatalog, type SetupJob, type SetupStart } from '@felan-ai/session-protocol';
import type { TuiSessionController } from './controller.js';
import type { TerminalSetupUi } from './setup-ui.js';
import open from 'open';

const REQUIRED = ['host.setup.catalog', 'host.setup.start', 'host.setup.read', 'host.setup.answer', 'host.setup.cancel'] as const;
const POLL_MS = 500;
const REQUEST_MS = 15_000;
const MAX_DURATION_MS = 10 * 60_000;
const CANCEL_MS = 1_500;
type SetupOperation = Extract<Operation, `host.setup.${string}`>;
interface Flow { abort: AbortController; done: Promise<boolean>; job?: SetupJob; cancelling?: Promise<void>; provider?: string }
type AuthType = 'oauth' | 'api_key';
type Provider = SetupCatalog['providers'][number];
type LoginOption = { provider: Provider; type: AuthType };
type Action = { kind: 'cancel' } | { kind: 'answer'; promptId: string; text: string } | { kind: 'link'; index: number };

export class TerminalSetup {
  private active: Flow | undefined;
  private closed = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly controller: TuiSessionController, private readonly ui: TerminalSetupUi,
    private readonly openBrowser: (url: string) => Promise<unknown> = url => open(url)) {}

  login(provider?: string): Promise<boolean> { return this.run(false, flow => this.loginFlow(flow, provider)); }
  logout(): Promise<boolean> { return this.run(false, flow => this.logoutFlow(flow)); }
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

  private async loginFlow(flow: Flow, providerRef?: string): Promise<boolean> {
    const catalog = await this.catalog(flow); const signal = flow.abort.signal;
    const options: LoginOption[] = catalog.providers.flatMap(provider => provider.methods.map(type => ({ provider, type })))
      .sort((a, b) => a.provider.label.localeCompare(b.provider.label));
    const reference = providerRef?.trim().toLowerCase();
    const matches = reference ? options.filter(({ provider }) => [provider.id.toLowerCase(), provider.label.toLowerCase()].includes(reference)) : [];
    const specific = matches.length > 1 && new Set(matches.map(({ provider }) => provider.id)).size === 1 ? matches : undefined;
    let selected = matches.length === 1 ? matches[0] : undefined;
    const searchProviders = !!reference && !selected && !specific;
    let page: 'types' | 'providers' = searchProviders ? 'providers' : 'types';
    let authType: AuthType | undefined;
    const canGoBack = !selected;
    while (!signal.aborted) {
      if (!selected && page === 'types') {
        const radius = !specific ? options.find(option => option.type === 'oauth' && option.provider.id === 'radius') : undefined;
        const choices = [
          ...(!specific || specific.some(option => option.type === 'oauth') ? [{ value: 'oauth', label: specific?.find(option => option.type === 'oauth')?.provider.oauthLabel ?? 'Sign in with an account' }] : []),
          ...(!specific || specific.some(option => option.type === 'api_key') ? [{ value: 'api_key', label: 'Sign in with an API key' }] : []),
          ...(radius ? [{ value: 'radius', label: `Sign in with ${radius.provider.label}${providerStatus(radius)}` }] : []),
        ];
        const choice = await this.ui.select(specific ? `Select authentication method for ${specific[0]!.provider.label}:` : 'Select authentication method:', choices, { signal });
        if (choice === undefined || signal.aborted) return false;
        if (choice === 'radius') selected = radius;
        else if (choice === 'oauth' || choice === 'api_key') {
          authType = choice;
          if (specific) selected = specific.find(option => option.type === authType);
          else page = 'providers';
        } else return false;
      }
      if (!selected && page === 'providers') {
        const providers = options.filter(option => !authType || option.type === authType);
        if (!providers.length) {
          this.controller.setNotice(authType === 'oauth' ? 'No account providers available.' : authType === 'api_key' ? 'No API key providers available.' : 'No login providers available.');
          return false;
        }
        const showTypes = new Set(providers.map(option => option.type)).size > 1;
        const choice = await this.ui.providers('Select provider to configure:', providers.map(option => ({
          value: `${option.provider.id}:${option.type}`,
          label: `${option.provider.label}${showTypes ? ` [${providerType(option.type, option.provider.subscription)}]` : ''}${providerStatus(option)}`,
          description: `${option.provider.id} ${option.type} ${option.provider.apiKeyName ?? ''}`,
        })), searchProviders ? providerRef : undefined, signal);
        if (signal.aborted) return false;
        if (choice === undefined) {
          if (!authType) return false;
          page = 'types'; continue;
        }
        selected = providers.find(option => `${option.provider.id}:${option.type}` === choice);
        if (!selected) return false;
      }
      if (!selected) continue;
      const { provider, type } = selected;
      if (type === 'api_key' && !provider.apiKeyLogin) {
        await this.ui.select(`${provider.label} setup`, [{ value: 'back', label: `${provider.apiKeyName ?? 'Authentication'} is configured outside Felan.` }], { signal });
        if (!canGoBack) return false;
      } else {
        if (provider.configured && !await this.ui.confirm('Replace credentials', `Replace existing credentials for ${provider.label}?`, { signal })) return false;
        if (signal.aborted) return false;
        flow.provider = provider.label;
        const completed = await this.start(flow, { kind: 'login', provider: provider.id, method: type, confirmed: true });
        if (completed || !canGoBack || !flow.job || terminal(flow.job)) return completed;
        await this.cancel(flow);
        while (!signal.aborted && !terminal(flow.job)) {
          flow.job = parseSchema(SetupJobSchema, await this.request('host.setup.read', { jobId: flow.job.id }, signal));
          if (!terminal(flow.job)) await delay(POLL_MS, signal);
        }
        delete flow.job; delete flow.cancelling;
      }
      selected = undefined;
    }
    return false;
  }

  private async logoutFlow(flow: Flow): Promise<boolean> {
    const { credentials } = await this.catalog(flow); const signal = flow.abort.signal;
    if (!credentials.length) {
      this.controller.setNotice('No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.');
      return false;
    }
    const showTypes = new Set(credentials.map(value => value.type)).size > 1;
    const selected = await this.ui.providers('Select provider to logout:', [...credentials].sort((a, b) => a.label.localeCompare(b.label)).map(value => ({
      value: value.id, label: `${value.label}${showTypes ? ` [${providerType(value.type, value.subscription)}]` : ''} ✓ configured`,
    })), undefined, signal);
    if (selected === undefined || signal.aborted || !credentials.some(value => value.id === selected)) return false;
    return this.start(flow, { kind: 'logout', provider: selected, confirmed: true });
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
      description: `${actionFor(value) === 'install' ? value.description : actionFor(value) === 'disable'
        ? `Disable ${value.label}; installed software is kept.` : actionFor(value) === 'enable'
        ? `Enable the installed ${value.label} extension.` : `No changes are available for ${value.label}.`}${value.reason ? ` ${value.reason}` : ''} Checked: ${actionFor(value)}. Unchecked: leave unchanged.` })), signal);
    if (selected === undefined || signal.aborted) return false;
    if (selected.some(id => !dependencies.some(value => value.id === id))) throw new Error('Unknown dependency choice.');
    const summary = dependencies.map(value => `${selected.includes(value.id) ? actionFor(value) : 'unchanged'}: ${value.label}`).join('\n');
    if (!await this.ui.confirm('Apply extension changes?', summary, { signal }) || signal.aborted) return false;
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
    const opened = new Set<string>();
    try {
      while (!signal.aborted) {
        const job = flow.job!;
        if (terminal(job)) {
          this.controller.setNotice(job.kind === 'logout' ? job.message : job.kind === 'login'
            ? `${job.state === 'completed' ? 'Logged in to' : job.state === 'cancelled' ? 'Login cancelled for' : 'Failed to login to'} ${flow.provider}. ${job.message}`
            : `Dependency setup ${job.state}. ${job.message}`);
          return job.state === 'completed';
        }
        if (job.kind === 'login' && this.controller.client.capabilities?.localConsole) {
          for (const link of job.links ?? []) {
            if (!link.autoOpen || opened.has(link.url) || !isBrowserUrl(link.url)) continue;
            opened.add(link.url);
            void this.openBrowser(link.url).catch(() => {});
          }
        }
        const key = JSON.stringify([job.state, job.prompt, job.links, job.prompt?.id === answered, job.prompt ? '' : job.message]);
        if (!view || view.key !== key) {
          view?.abort.abort();
          const abort = new AbortController();
          view = { key, abort, result: this.present(job, abort.signal, answered, flow.provider).then(value => ({ kind: 'action' as const, value })) };
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

  private async present(job: SetupJob, signal: AbortSignal, answered?: string, provider?: string): Promise<Action> {
    if (job.kind === 'login') {
      const current = { ...job };
      if (current.prompt?.id === answered) delete current.prompt;
      const text = await this.ui.login(current, provider!, signal);
      if (text === undefined || signal.aborted || !current.prompt) return { kind: 'cancel' };
      if (current.prompt.kind === 'select' && !current.prompt.choices.some(choice => choice.id === text)) return { kind: 'cancel' };
      return { kind: 'answer', promptId: current.prompt.id, text };
    }
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

function isBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !/[\u0000-\u0020\u007f]/u.test(value);
  } catch { return false; }
}

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

function providerType(type: AuthType, subscription: boolean): string {
  return type === 'api_key' ? 'API key' : subscription ? 'subscription' : 'account';
}

function providerStatus({ provider, type }: LoginOption): string {
  const status = provider.status;
  if (!status) return ' • not configured';
  if (status.type !== type) return ` • ${providerType(status.type, provider.subscription)} configured`;
  if (!status.source || status.source === 'OAuth' || status.source === 'stored credential') return ' ✓ configured';
  const source = /^[A-Z][A-Z0-9_]*(?:, [A-Z][A-Z0-9_]*)*$/.test(status.source) ? `env: ${status.source}` : status.source;
  return ` ✓ ${source}`;
}
