import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { CURRENT_SESSION_VERSION, SESSION_EXECUTION_LIMITS, type ModelReference, type SessionExecutionInput, type SessionManager } from '@felan-ai/agent-core';
import type { ControlSession, ControlSessionMetadata, ExecutionMetadata } from './control-state.js';
import type { SessionRegistry } from './registry.js';
import { redact } from '../logger.js';

export interface ExecutionSettings { readonly concurrency?: number; readonly maxDepth?: number }
export interface ExecutionCompletionNotice {
  readonly deliveryId: string; readonly parentSessionId: string; readonly executionId: string; readonly label: string;
  readonly status: 'completed' | 'failed' | 'timed_out' | 'cancelled'; readonly summary?: string;
  readonly error?: { readonly code: string; readonly message: string };
}
export interface ExecutionParentPort {
  deliverCompletion(notice: ExecutionCompletionNotice): Promise<'delivered' | 'queued' | 'unavailable'>;
  acknowledgeCompletion?(deliveryId: string): void;
}
export interface ExecutionRecord {
  readonly executionId: string; readonly parentSessionId: string; readonly rootSessionId: string;
  readonly label: string; readonly description: string; readonly status: 'queued' | 'running' | ExecutionCompletionNotice['status'];
  readonly createdAt: string; readonly startedAt?: string; readonly completedAt?: string; readonly completionPending: boolean;
  readonly result?: string; readonly error?: ExecutionCompletionNotice['error']; readonly sessionId: string;
  readonly model?: ModelReference; readonly usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; cost: number };
}
type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
interface Job { readonly id: string; readonly controller: AbortController; readonly promise: Promise<void>; cancelling?: Promise<void> }
const synthesis = 'Stop using tools. Summarize the work completed, findings, and any remaining uncertainty in a concise final response.';

export class ExecutionHost {
  constructor(private readonly manager: RegistryExecutions, readonly sessionId: string) {}
  activate(): void { this.manager.activate(this.sessionId); }
  configure(settings: ExecutionSettings): void { this.manager.configure(settings); }
  attachParent(port: ExecutionParentPort): () => void { return this.manager.attachParent(this.sessionId, port); }
  spawnSession(input: SessionExecutionInput, signal?: AbortSignal) { return this.manager.spawn(this.sessionId, input, signal); }
  getResult(id: string, options?: { readonly acknowledge?: boolean }) { return this.manager.result(this.sessionId, id, options); }
  listExecutions(descendants = false): readonly ExecutionRecord[] { return this.manager.list(this.sessionId, descendants); }
  getExecution(id: string): ExecutionRecord | undefined { return this.listExecutions().find(row => row.executionId === id); }
  scopeToSession(id: string): ExecutionHost {
    if (id !== this.sessionId && !this.listExecutions(true).some(row => row.sessionId === id)) throw new Error('Session does not belong to this execution scope.');
    return new ExecutionHost(this.manager, id);
  }
  steer(id: string, message: string) { return this.manager.steer(this.sessionId, id, message); }
  cancel(id: string, reason?: string) { return this.manager.cancel(this.sessionId, id, reason); }
  subscribe(listener: (records: readonly ExecutionRecord[]) => void): () => void { return this.manager.subscribe(() => listener(this.listExecutions(true))); }
  hasPendingWork(): boolean { return this.manager.pending(this.sessionId); }
  hasActiveJobs(): boolean { return this.manager.jobs(this.sessionId).length > 0; }
  hasExecutingJobs(): boolean { return this.hasActiveJobs(); }
  resumeQueued(): void { this.manager.drain(); }
  settle(): Promise<void> { return this.manager.settle(this.sessionId); }
  shutdown(): Promise<void> { return this.manager.shutdown(this.sessionId); }
}

export class RegistryExecutions {
  private readonly active = new Map<string, Job>();
  private readonly parents = new Map<string, ExecutionParentPort>();
  private readonly listeners = new Set<() => void>();
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly closed = new Set<string>();
  private readonly failures = new Set<unknown>();
  private control = Promise.resolve();
  private draining = false;
  private concurrency = 4;
  private maxDepth = 3;
  constructor(private readonly registry: SessionRegistry, readonly root: string) {}

  configure(settings: ExecutionSettings): void {
    this.concurrency = bounded(settings.concurrency, 4, 32);
    this.maxDepth = bounded(settings.maxDepth, 3, 10);
  }
  activate(id: string): void { this.closed.delete(id); }
  host(id: string): ExecutionHost { return new ExecutionHost(this, id); }
  private rows(): ControlSessionMetadata[] { return this.registry.list().filter(row => row.root === this.root && row.execution); }
  private descendants(id: string): Set<string> {
    const ids = new Set([id]);
    for (let previous = -1; previous !== ids.size;) {
      previous = ids.size;
      for (const row of this.rows()) if (row.parent && ids.has(row.parent)) ids.add(row.id);
    }
    return ids;
  }
  jobs(id: string): Job[] { const ids = this.descendants(id); return [...this.active.values()].filter(job => ids.has(job.id)); }
  pending(id: string): boolean {
    const ids = this.descendants(id);
    return this.rows().some(row => ids.has(row.id) && (!row.execution!.completedAt || row.parent === id && row.execution!.completionPending));
  }
  private checkParent(id: string): void {
    this.registry.assertNewWork(); this.registry.assertDispatch(id);
    if (this.closed.has(this.root) || this.closed.has(id)) throw new Error('Execution host is closed.');
  }
  private direct(parent: string, id: string): ControlSessionMetadata {
    const row = this.rows().find(row => row.id === id && row.parent === parent);
    if (!row) throw Object.assign(new Error('Execution is not a direct child of this session.'), { code: 'not_child' });
    return row;
  }
  private update(id: string, execution: ExecutionMetadata): void {
    try {
      const commit = this.registry.options.store.updateSession(id, { execution });
      this.registry.publishCommitted(commit.revisions);
    }
    catch (error) { this.registry.failExecution(error); throw error; }
    this.emit();
  }
  private emit(): void {
    for (const row of this.registry.list().filter(row => row.root === this.root)) {
      if (this.registry.binding(row.id)) this.registry.projection(row.id).setExecutionsGeneration(createHash('sha256').update(randomUUID()).digest('hex'));
    }
    for (const listener of this.listeners) { try { listener(); } catch {} }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async spawn(parent: string, request: SessionExecutionInput, signal?: AbortSignal): Promise<Result<ExecutionRecord>> {
    return this.serialize(async () => {
      this.checkParent(parent);
      if (signal?.aborted) return failure('invalid_request', 'Execution startup was aborted');
      let owner = this.registry.options.store.session(parent); let depth = 0;
      if (owner.execution?.completedAt) return failure('parent_unavailable', 'Parent execution is no longer active');
      if (owner.execution?.request.allowChildren === false) return failure('depth_exceeded', 'Parent does not allow child executions');
      while (owner.parent) { depth++; owner = this.registry.options.store.session(owner.parent); }
      if (depth >= this.maxDepth) return failure('depth_exceeded', 'Maximum execution depth reached');
      const models = this.registry.binding(parent)!.runtime.session.modelRuntime;
      const model = request.model ? models.getModel(request.model.provider, request.model.id) : undefined;
      if (request.model && (!model || !models.hasConfiguredAuth(model.provider))) return failure('unsupported_model', 'The requested model is unavailable or unauthenticated');
      if (request.thinking && request.thinking !== 'off' && (!model?.reasoning
        || (request.thinking === 'xhigh' || request.thinking === 'max' ? model.thinkingLevelMap?.[request.thinking] == null : model.thinkingLevelMap?.[request.thinking] === null))) {
        return failure('unsupported_thinking', 'The resolved model does not support the requested thinking level');
      }
      const { excludedTools, ...input } = structuredClone(request);
      const execution: ExecutionMetadata = { request: { ...input, ...(excludedTools ? { excludedTools: [...excludedTools] } : {}) }, createdAt: new Date().toISOString(), deliveryId: randomUUID(), completionPending: false };
      // A busy child keeps spawning while its root reloads, so fall back to the root's stored location.
      const stored = this.registry.options.store.session(this.root);
      const root = this.registry.binding(this.root)?.resources ?? { cwd: stored.cwd, sessionDir: dirname(stored.piPath) };
      const binding = await this.registry.create({ cwd: root.cwd, sessionDir: root.sessionDir, target: { kind: 'new', id: randomUUID() },
        rootSessionId: this.root, parentSessionId: parent, policy: this.registry.getPolicy(parent), extensionPaths: stored.profile?.extensionPaths ?? [], execution,
        systemPromptAppend: request.appendSystemPrompt ?? '', ...(model ? { model } : {}), ...(request.thinking ? { thinkingLevel: request.thinking } : {}) });
      if (signal?.aborted || this.closed.has(this.root) || this.closed.has(parent) || this.registry.options.store.session(parent).execution?.completedAt) {
        this.finish(binding.sessionId, 'cancelled', { code: 'host_shutdown', message: 'Execution startup was interrupted' });
        return failure('invalid_request', 'Execution startup was aborted');
      }
      this.emit();
      const record = this.view(this.registry.options.store.session(binding.sessionId));
      this.drain();
      return success(record);
    });
  }

  list(parent: string, descendants = false): readonly ExecutionRecord[] {
    const ids = descendants ? this.descendants(parent) : new Set([parent]);
    return this.rows().filter(row => row.parent && ids.has(row.parent)).map(row => this.view(row)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async result(parent: string, id: string, options?: { readonly acknowledge?: boolean }): Promise<Result<ExecutionRecord>> {
    try {
      const row = this.direct(parent, id); const result = this.view(row);
      if (options?.acknowledge && row.execution!.completedAt && row.execution!.completionPending) {
        this.parents.get(parent)?.acknowledgeCompletion?.(row.execution!.deliveryId);
        this.update(id, { ...row.execution!, completionPending: false });
      }
      return success(result);
    } catch (error) { return asFailure(error); }
  }
  async steer(parent: string, id: string, message: string): Promise<Result<ExecutionRecord>> {
    return this.serialize(async () => {
      try {
        this.checkParent(parent);
        const row = this.direct(parent, id); const execution = row.execution!;
        if (!execution.completedAt) {
          if (this.active.has(id)) await this.registry.binding(id)!.runtime.session.steer(message);
          else {
            const queued = [execution.message ?? execution.request.prompt, message].join('\n\n');
            if (Buffer.byteLength(queued) > SESSION_EXECUTION_LIMITS.promptBytes) return failure('invalid_request', 'Queued execution input exceeds the prompt limit');
            this.update(id, { ...execution, message: queued });
          }
        } else {
          if (!(execution.outcome === 'completed' || execution.error?.code === 'model_request_failed' || execution.error?.code === 'turn_limit_reached' || execution.error?.code === 'host_shutdown')) {
            return failure('not_steerable', 'Only retained completed or recoverable executions can be continued');
          }
          try { readEntries(this.registry, row); } catch { return failure('not_steerable', 'The retained execution session is unavailable'); }
          await this.registry.restore(id, { systemPromptAppend: execution.request.appendSystemPrompt ?? '' });
          this.checkParent(parent); this.registry.assertDispatch(id);
          this.parents.get(parent)?.acknowledgeCompletion?.(execution.deliveryId);
          this.clearRetry(id);
          this.update(id, { request: execution.request, createdAt: execution.createdAt, deliveryId: randomUUID(), completionPending: false, message });
          this.drain();
        }
        return success(this.view(this.registry.options.store.session(id)));
      } catch (error) { return asFailure(error, 'not_steerable'); }
    });
  }
  async cancel(parent: string, id: string, reason = 'Cancelled by parent'): Promise<Result<ExecutionRecord>> {
    try { this.direct(parent, id); await this.cancelTree(id, reason); return success(this.view(this.direct(parent, id))); }
    catch (error) { return asFailure(error); }
  }
  private async cancelTree(id: string, message: string, code = 'cancelled_by_parent', outcome: 'cancelled' | 'timed_out' = 'cancelled'): Promise<void> {
    const ids = this.descendants(id);
    for (const row of this.rows().filter(row => ids.has(row.id) && !row.execution!.completedAt)) {
      this.finish(row.id, outcome, { code, message });
      const job = this.active.get(row.id);
      if (job) {
        job.controller.abort();
        job.cancelling ??= this.registry.binding(row.id)!.runtime.session.abort();
        void job.cancelling.catch(error => this.failures.add(error));
      } else void this.deliver(row.id);
    }
    await Promise.all(this.jobs(id).map(job => job.promise));
    this.drain();
  }
  drain(): void {
    if (this.draining || this.closed.has(this.root)) return;
    this.draining = true;
    queueMicrotask(() => {
      try {
        for (const row of this.rows()) {
          if (this.active.size >= this.concurrency) break;
          if (row.execution!.startedAt || row.execution!.completedAt || this.active.has(row.id) || this.closed.has(row.id)) continue;
          try { this.checkParent(row.parent!); this.registry.assertDispatch(row.id); }
          catch { continue; }
          this.update(row.id, { ...row.execution!, startedAt: new Date().toISOString() });
          const controller = new AbortController();
          const promise = Promise.resolve().then(() => this.run(row.id, controller.signal));
          const job: Job = { id: row.id, controller, promise };
          this.active.set(row.id, job);
          void promise.catch(error => this.failures.add(error)).finally(() => { this.active.delete(row.id); this.drain(); });
        }
      } catch (error) { this.failures.add(error); }
      finally { this.draining = false; }
    });
  }
  private async run(id: string, signal: AbortSignal): Promise<void> {
    const row = this.registry.options.store.session(id); const execution = row.execution!;
    const session = this.registry.binding(id)!.runtime.session;
    const tools = session.getActiveToolNames();
    const start = session.sessionManager.getEntries().length;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let turns = 0; let limit = false; let unsubscribe = () => {};
    try {
      if (execution.request.timeoutMs) {
        timeout = setTimeout(() => { void this.cancelTree(id, `Execution timed out after ${execution.request.timeoutMs} milliseconds`, 'timed_out', 'timed_out').catch(error => this.failures.add(error)); }, execution.request.timeoutMs);
        timeout.unref();
      }
      session.setActiveToolsByName(tools.filter(name => !execution.request.excludedTools?.includes(name)));
      unsubscribe = session.subscribe(event => {
        if (event.type !== 'turn_end') return;
        this.emit(); turns++;
        if (execution.request.maxTurns && event.message.role === 'assistant' && event.message.stopReason === 'toolUse') {
          if (turns >= execution.request.maxTurns) { limit = true; void session.abort().catch(error => this.failures.add(error)); }
          else if (turns === execution.request.maxTurns - 1) { session.setActiveToolsByName([]); void session.steer(synthesis).catch(error => this.failures.add(error)); }
        }
      });
      let prompt = execution.message ?? execution.request.prompt;
      if (execution.request.maxTurns === 1) { session.setActiveToolsByName([]); prompt += `\n\n${synthesis}`; }
      if (!signal.aborted) {
        this.registry.assertDispatch(id);
        this.registry.projection(id).setOrigin({ kind: 'automation', source: 'execution' });
        await session.prompt(prompt);
      }
      await this.active.get(id)?.cancelling;
      if (!this.registry.options.store.session(id).execution!.completedAt) {
        const assistant = session.sessionManager.getEntries().slice(start).reverse().find(entry => entry.type === 'message' && entry.message.role === 'assistant');
        if (limit) this.finish(id, 'cancelled', { code: 'turn_limit_reached', message: `Execution reached its ${execution.request.maxTurns} turn limit` });
        else if (assistant?.type !== 'message' || assistant.message.role !== 'assistant') this.finish(id, 'failed', { code: 'internal_error', message: 'Execution completed without an assistant response' });
        else if (assistant.message.stopReason !== 'stop') this.finish(id, 'failed', { code: assistant.message.stopReason === 'error' ? 'model_request_failed' : 'internal_error',
          message: assistant.message.stopReason === 'error' ? `Model request failed: ${sanitize(assistant.message.errorMessage)}` : `Execution ended without a final response (${assistant.message.stopReason})` });
        else if (!assistant.message.content.some(part => part.type === 'text' && part.text.trim())) this.finish(id, 'failed', { code: 'internal_error', message: 'Execution completed without a final result' });
        else this.finish(id, 'completed');
      }
    } catch (error) {
      if (!this.registry.options.store.session(id).execution!.completedAt) this.finish(id, 'failed', { code: 'internal_error', message: 'Execution failed unexpectedly' });
      if (this.active.get(id)?.cancelling) this.failures.add(error);
    } finally {
      if (timeout) clearTimeout(timeout);
      unsubscribe(); session.setActiveToolsByName(tools);
      this.registry.projection(id).refresh();
    }
    await this.deliver(id);
  }
  private finish(id: string, outcome: ExecutionCompletionNotice['status'], error?: ExecutionCompletionNotice['error']): void {
    const execution = this.registry.options.store.session(id).execution!;
    const { message: _message, ...retained } = execution;
    this.update(id, { ...retained, completedAt: new Date().toISOString(), outcome, ...(error ? { error } : {}), completionPending: execution.request.notifyOnCompletion === true });
  }
  private view(row: ControlSessionMetadata): ExecutionRecord {
    const execution = row.execution!;
    let entries: ReturnType<SessionManager['getEntries']> | undefined;
    try { entries = this.registry.binding(row.id)?.runtime.session.sessionManager.getEntries() ?? readEntries(this.registry, row); } catch {}
    const usage = entries && { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cost: 0 };
    let result: string | undefined;
    for (const entry of entries ?? []) {
      if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
      const message = entry.message;
      if (usage) { usage.input += message.usage.input; usage.output += message.usage.output; usage.cacheRead += message.usage.cacheRead;
        usage.cacheWrite += message.usage.cacheWrite; usage.cacheWrite1h += message.usage.cacheWrite1h ?? 0; usage.cost += message.usage.cost.total; }
      if (execution.outcome === 'completed' && execution.completedAt && entry.timestamp <= execution.completedAt) result = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    }
    return { executionId: row.id, parentSessionId: row.parent!, rootSessionId: row.root, sessionId: row.id,
      label: execution.request.label ?? 'session', description: execution.request.description, createdAt: execution.createdAt,
      ...(execution.startedAt ? { startedAt: execution.startedAt } : {}), ...(execution.completedAt ? { completedAt: execution.completedAt } : {}),
      status: execution.outcome ?? (execution.startedAt ? 'running' : 'queued'), completionPending: execution.completionPending,
      ...(row.model ? { model: row.model } : {}), ...(usage ? { usage } : {}), ...(result === undefined ? {} : { result }), ...(execution.error ? { error: execution.error } : {}) };
  }
  attachParent(parent: string, port: ExecutionParentPort): () => void {
    this.parents.set(parent, port);
    queueMicrotask(() => { for (const row of this.rows().filter(row => row.parent === parent)) void this.deliver(row.id); });
    return () => { if (this.parents.get(parent) === port) this.parents.delete(parent); };
  }
  private clearRetry(id: string): void { const timer = this.retries.get(id); if (timer) clearTimeout(timer); this.retries.delete(id); }
  private async deliver(id: string): Promise<void> {
    const row = this.registry.options.store.session(id); const execution = row.execution!;
    if (!execution.completionPending || this.closed.has(this.root) || !this.parents.has(row.parent!)) return;
    const existing = this.deliveries.get(id); if (existing) return existing;
    const delivery = (async () => {
      try {
        this.registry.assertDispatch(row.parent!);
        const record = this.view(row);
        const outcome = await this.parents.get(row.parent!)!.deliverCompletion({ deliveryId: execution.deliveryId, executionId: id, parentSessionId: row.parent!, label: record.label,
          status: execution.outcome!, ...(record.result === undefined ? {} : { summary: record.result.slice(0, 4000) }), ...(execution.error ? { error: execution.error } : {}) });
        const current = this.registry.options.store.session(id).execution!;
        if (current.deliveryId !== execution.deliveryId || !current.completionPending) return;
        if (outcome === 'delivered') { this.clearRetry(id); this.update(id, { ...current, completionPending: false }); return; }
      } catch {}
      if (!this.closed.has(this.root) && !this.retries.has(id)) {
        const retry = setTimeout(() => { this.retries.delete(id); void this.deliver(id); }, 100);
        retry.unref(); this.retries.set(id, retry);
      }
    })();
    this.deliveries.set(id, delivery);
    try { await delivery; } finally { this.deliveries.delete(id); }
  }
  async settle(id: string): Promise<void> {
    for (;;) {
      const control = this.control;
      const promises = [...this.jobs(id).map(job => job.promise), ...this.deliveries.values()];
      await Promise.allSettled([...promises, control]);
      if (control === this.control && this.jobs(id).every(job => promises.includes(job.promise))) break;
    }
    if (this.failures.size) throw new AggregateError([...this.failures], 'Execution writers did not settle cleanly.');
  }
  async shutdown(id: string): Promise<void> {
    this.closed.add(id);
    for (const child of this.descendants(id)) this.clearRetry(child);
    await this.control;
    await this.cancelTree(id, 'Daemon execution host stopped', 'host_shutdown');
    await this.settle(id);
  }
  private async serialize<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.control; let release!: () => void;
    this.control = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  }
}

function readEntries(registry: SessionRegistry, row: ControlSessionMetadata): ReturnType<SessionManager['getEntries']> {
  const path = registry.options.owner.assertOwnsPath(row.piPath);
  if (statSync(path).size > 64 * 1024 * 1024) throw new Error('Retained execution exceeds the file bound.');
  const [header, ...entries] = readFileSync(path, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  if (header?.type !== 'session' || header.id !== row.id || header.version !== CURRENT_SESSION_VERSION) throw new Error('Invalid retained execution session.');
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid retained session entry.');
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;
    const { content, usage } = entry.message;
    if (!Array.isArray(content) || content.some(part => !part || typeof part.type !== 'string' || part.type === 'text' && typeof part.text !== 'string')
      || !usage || ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cacheWrite1h ?? 0, usage.cost?.total].every(value => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error('Invalid retained assistant message.');
    }
  }
  return entries;
}
function sanitize(value: string | undefined): string { return redact(value ?? 'unknown provider error').replace(/[\u0000-\u001F\u007F-\u009F]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 300); }
function bounded(value: number | undefined, fallback: number, maximum: number): number { return value === undefined || !Number.isInteger(value) ? fallback : Math.max(1, Math.min(maximum, value)); }
function success<T>(value: T): Result<T> { return { ok: true, value }; }
function failure(code: string, message: string): Result<never> { return { ok: false, error: { code, message } }; }
function asFailure(error: unknown, fallback = 'host_unavailable'): Result<never> { return failure(error && typeof error === 'object' && 'code' in error ? String(error.code) : fallback, error instanceof Error ? error.message : 'Execution is unavailable'); }
