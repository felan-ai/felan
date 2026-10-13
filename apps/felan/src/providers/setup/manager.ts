import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { AgentRuntime, ModelRuntime, RuntimeDependencyInstallResult } from '@felan-ai/agent-core';
import { SetupCatalogSchema, SetupJobSchema, SetupStartSchema, parseSchema, type SetupCatalog, type SetupJob, type SetupStart } from '@felan-ai/session-protocol';
import { isBuiltinExtensionEnabled, isDependencyOnboardingComplete, mergeDaemonGlobalSettings, readDaemonGlobalSettings } from '../global-settings.js';
import { AuthCleanupError, startAuthWorker } from './auth-driver.js';
import type { SetupDependency } from '@felan-ai/daemon/session-runtime';
import { commandError } from '@felan-ai/daemon/provider';

interface Job {
  client: string;
  view: SetupJob;
  control: AbortController;
  work: Promise<void>;
  answer?: (id: string, text: string) => Promise<void>;
  committed?: boolean;
}

export interface SetupManagerOptions {
  agentDir: string;
  runtime: AgentRuntime;
  models: Pick<ModelRuntime, 'getProviders' | 'hasConfiguredAuth'>;
  assertCurrent(): void;
  dependencies?: readonly SetupDependency[];
  login?: typeof startAuthWorker;
  refreshModels?(signal: AbortSignal): Promise<void>;
  open(value: string, signal: AbortSignal): Promise<void>;
}

export class HostSetupManager {
  private readonly jobs = new Map<string, Job>();
  private readonly dependencies: readonly SetupDependency[];
  private closed = false;
  private failure: unknown;

  constructor(private readonly options: SetupManagerOptions) { this.dependencies = options.dependencies ?? []; }

  dependency(id: string): { readonly label: string; readonly description: string } | undefined {
    this.check();
    const value = this.dependencies.find(dependency => dependency.id === id && dependency.install);
    return value ? { label: value.label, description: value.description } : undefined;
  }

  async installApprovedDependency(id: string, signal?: AbortSignal): Promise<RuntimeDependencyInstallResult> {
    this.check();
    if (signal?.aborted) return { status: 'cancelled', message: 'Dependency installation was cancelled.' };
    if (!this.dependency(id)) return { status: 'unavailable', message: 'Dependency installation is unavailable.' };
    const client = `runtime-dependency-${randomUUID()}`;
    const view = this.start({ kind: 'dependencies', confirmed: true, choices: [{ id, action: 'install' }] }, client);
    const job = this.jobs.get(view.id)!;
    const abort = () => this.abort(job);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) abort();
      await job.work;
      if (job.view.state === 'completed') return { status: 'installed' };
      return job.view.state === 'cancelled' ? { status: 'cancelled', message: 'Dependency installation was cancelled.' }
        : { status: 'unavailable', message: 'Dependency installation failed; inspect the local installation before retrying.' };
    } finally { signal?.removeEventListener('abort', abort); }
  }

  async catalog(): Promise<SetupCatalog> {
    this.check();
    const settings = await readDaemonGlobalSettings(this.options.agentDir, this.options.assertCurrent);
    const providers = this.options.models.getProviders().flatMap(provider => {
      const methods: Array<'oauth' | 'api_key'> = [];
      if (provider.auth.oauth) methods.push('oauth');
      if (provider.auth.apiKey?.login) methods.push('api_key');
      return methods.length ? [{ id: provider.id, label: clean(provider.name || provider.id), configured: this.options.models.hasConfiguredAuth(provider.id), methods }] : [];
    });
    const dependencies = await Promise.all(this.dependencies.map(async dependency => {
      let status: Awaited<ReturnType<SetupDependency['check']>>;
      try { status = await dependency.check(this.options.runtime); }
      catch { status = { available: false, reason: 'Dependency detection failed; inspect the local installation before retrying.' }; }
      return { id: dependency.id, label: dependency.label, description: dependency.description,
        enabled: isBuiltinExtensionEnabled(settings, dependency.extension), available: status.available, installable: !!dependency.install,
        needsSetup: !isDependencyOnboardingComplete(settings, dependency.extension, dependency.revision),
        ...(status.version === undefined ? {} : { version: boundedText(clean(status.version), 128) }),
        ...(status.reason === undefined ? {} : { reason: boundedText(clean(status.reason), 4096) }) };
    }));
    this.check(); return parseSchema(SetupCatalogSchema, { providers, dependencies });
  }

  validateStart(value: SetupStart): void {
    this.check(); const request = parseSchema(SetupStartSchema, value);
    if ([...this.jobs.values()].filter(job => !terminal(job.view)).length >= 8) throw commandError('request_capacity');
    if (request.kind === 'login') {
      const provider = this.options.models.getProviders().find(provider => provider.id === request.provider);
      if (!provider || !(request.method === 'oauth' ? provider.auth.oauth : provider.auth.apiKey?.login)) throw commandError('unavailable');
      if ([...this.jobs.values()].some(job => !terminal(job.view) && job.view.kind === 'login')) throw commandError('busy');
    } else {
      if (new Set(request.choices.map(choice => choice.id)).size !== request.choices.length) throw commandError('invalid_request');
      if (request.choices.some(choice => !this.dependencies.some(dependency => dependency.id === choice.id
        && (choice.action !== 'install' || dependency.install)))) throw commandError('invalid_request');
      if ([...this.jobs.values()].some(job => !terminal(job.view) && job.view.kind === 'dependencies')) throw commandError('busy');
    }
  }

  start(request: SetupStart, client: string): SetupJob {
    this.validateStart(request);
    const job: Job = { client, control: new AbortController(), work: Promise.resolve(), view: {
      id: randomUUID(), kind: request.kind, state: 'running', message: request.kind === 'login' ? 'Starting provider sign-in…' : 'Preparing dependencies…',
    } };
    this.jobs.set(job.view.id, job);
    job.work = Promise.resolve().then(async () => {
      const message = request.kind === 'login' ? await this.login(job, request) : await this.install(job, request);
      if (!job.committed) job.control.signal.throwIfAborted(); this.options.assertCurrent();
      job.view = { id: job.view.id, kind: job.view.kind, state: 'completed', message: message ?? (request.kind === 'login' ? 'Authentication saved.' : 'Dependencies updated. New sessions or an explicit reload pick up changes.') };
    }).catch(error => {
      if (error instanceof AuthCleanupError) this.failure = error;
      job.view = { id: job.view.id, kind: job.view.kind, state: job.control.signal.aborted ? 'cancelled' : 'failed',
        message: job.control.signal.aborted ? 'Setup cancelled.' : 'Setup failed. No automatic retry was attempted.' };
    }).finally(() => {
      delete job.answer;
      for (const [id, older] of this.jobs) {
        if (this.jobs.size <= 32) break;
        if (terminal(older.view)) this.jobs.delete(id);
      }
    });
    return this.read(job.view.id, client);
  }

  read(id: string, client: string): SetupJob { return parseSchema(SetupJobSchema, structuredClone(this.owned(id, client).view)); }

  async answer(id: string, promptId: string, text: string, client: string): Promise<void> {
    this.check(); const job = this.owned(id, client);
    if (job.view.state !== 'waiting' || job.view.prompt?.id !== promptId || !job.answer) throw commandError('already_resolved');
    if (job.view.prompt.kind === 'select' && !job.view.prompt.choices.some(choice => choice.id === text)) throw commandError('invalid_request');
    delete job.view.prompt; job.view.state = 'running';
    await job.answer(promptId, text);
  }

  cancel(id: string, client: string): void {
    this.abort(this.owned(id, client));
  }

  prepareOpenLink(id: string, index: number, client: string): () => Promise<void> {
    this.check(); const job = this.owned(id, client); const link = job.view.links?.[index];
    if (!link || terminal(job.view)) throw commandError('not_found');
    return () => this.options.open(link.url, job.control.signal);
  }

  disconnected(client: string): void { for (const job of this.jobs.values()) if (job.client === client) this.abort(job); }
  beginDrain(): void { this.closed = true; for (const job of this.jobs.values()) this.abort(job); }
  async drain(): Promise<void> { this.beginDrain(); await Promise.all([...this.jobs.values()].map(job => job.work)); if (this.failure) throw this.failure; }

  private check(): void { this.options.assertCurrent(); if (this.closed || this.failure) throw commandError('unavailable'); }
  private abort(job: Job): void { if (!terminal(job.view)) { job.view.state = 'cancelling'; delete job.view.prompt; job.control.abort(); } }
  private owned(id: string, client: string): Job {
    this.options.assertCurrent(); const job = this.jobs.get(id);
    if (!job || job.client !== client) throw commandError('forbidden'); return job;
  }

  private async login(job: Job, request: Extract<SetupStart, { kind: 'login' }>): Promise<string | undefined> {
    const driver = await (this.options.login ?? startAuthWorker)(this.options.runtime, {
      kind: 'start', agentDir: this.options.agentDir, provider: request.provider, method: request.method,
    }, { signal: job.control.signal, event: event => {
      if (job.control.signal.aborted) return;
      if (event.kind === 'prompt') { job.view.prompt = event.prompt; job.view.state = 'waiting'; }
      else if (event.kind === 'dismiss' && job.view.prompt?.id === event.promptId) { delete job.view.prompt; job.view.state = 'running'; }
      else if (event.kind === 'info') job.view.message = event.message;
      else if (event.kind === 'link') {
        const links = job.view.links ?? [];
        if (links.length >= 16) throw new Error('Too many authentication links.');
        job.view.links = [...links, { label: event.label, url: event.url }];
      }
    } });
    job.answer = driver.answer; await driver.done;
    try { await this.options.refreshModels?.(job.control.signal); }
    catch {
      job.control.signal.throwIfAborted();
      return 'Authentication saved. Model availability could not be refreshed; open a new session to retry.';
    }
    return undefined;
  }

  private async install(job: Job, request: Extract<SetupStart, { kind: 'dependencies' }>): Promise<void> {
    const runtime = cancellableRuntime(this.options.runtime, job.control.signal);
    for (const choice of request.choices) {
      job.control.signal.throwIfAborted(); this.options.assertCurrent();
      const dependency = this.dependencies.find(dependency => dependency.id === choice.id)!;
      let enabled = choice.action === 'install' || choice.action === 'enable';
      if (choice.action === 'install') {
        job.view.message = `Installing ${dependency.label}…`;
        await dependency.install!(runtime, value => { if (!job.control.signal.aborted) job.view.message = clean(value); });
        if (!(await dependency.check(runtime)).available) throw new Error('Installed dependency is unavailable.');
      } else if (choice.action === 'skip') {
        const current = await readDaemonGlobalSettings(this.options.agentDir, this.options.assertCurrent);
        const available = (await dependency.check(runtime)).available;
        enabled = dependency.skipDisables && !available ? false : isBuiltinExtensionEnabled(current, dependency.extension);
      }
      job.control.signal.throwIfAborted();
      await mergeDaemonGlobalSettings(this.options.agentDir, { extensions: [], dependencyDecisions: [{ extension: dependency.extension, revision: dependency.revision, enabled }] }, this.options.assertCurrent);
    }
    job.committed = true;
  }
}

function terminal(job: SetupJob): boolean { return ['completed', 'cancelled', 'failed'].includes(job.state); }
function clean(value: string): string { return boundedText(stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' '), 8192); }
function cancellableRuntime(runtime: AgentRuntime, signal: AbortSignal): AgentRuntime {
  return new Proxy(runtime, { get(target, key) {
    if (key === 'exec' || key === 'shell') return (...args: unknown[]) => {
      signal.throwIfAborted(); const index = key === 'exec' ? 2 : 1;
      const options = (args[index] ?? {}) as { signal?: AbortSignal };
      args[index] = { ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal };
      return Reflect.apply(Reflect.get(target, key, target), target, args);
    };
    const value: unknown = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
}

function boundedText(value: string, bytes: number): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  let result = ''; let size = 0;
  for (const point of value) { size += Buffer.byteLength(point); if (size > bytes) break; result += point; }
  return result;
}
