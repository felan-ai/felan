import type { DaemonIdentity, HostBlocked, OperationParams, OperationResult } from '@felan-ai/session-protocol';
import type { AdmittedCommand, AdmissionOutcome } from './admission.js';
import { accepted, commandError } from './commands.js';
import { assertTargetIdentity, type ResolvedDaemonTarget } from './target.js';
import { ShutdownError, shutdownDetail, shutdownMessage, type ShutdownStep } from './shutdown-error.js';

export type HostState = OperationResult<'host.status'>['state'];
export type HostAction = 'stop' | 'restart';
export type HostMode = OperationParams<'host.stop'>['mode'];
export interface HostLifecycleOptions {
  target: ResolvedDaemonTarget;
  identity: DaemonIdentity;
  beginDrain(): void;
  /** Reopens admission after a drain was abandoned; throws when the daemon can no longer resume. */
  endDrain(): void;
  /** Settlement must stop before releasing anything once `signal` aborts. */
  settle(mode: HostMode, signal: AbortSignal): Promise<void>;
  complete(action: HostAction): Promise<void>;
  timeoutMs?: number;
  canRetry?(): boolean;
  onBlocked?(blocked: HostBlocked, error: unknown): void;
  record?(event: 'stop_requested' | 'restart_requested' | 'drain_blocked' | 'drain_cancelled' | 'releasing'): void;
}

interface PendingAction { id: string; action: HostAction; mode: HostMode; generation: number; abort: AbortController }

export class HostLifecycle {
  private current: HostState = 'ready';
  private generation = 0;
  private completing = false;
  private pending: PendingAction | undefined;
  private blockedRecord: HostBlocked | undefined;
  private readonly timeout: number;

  constructor(private readonly options: HostLifecycleOptions) {
    this.timeout = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeout) || this.timeout < 1 || this.timeout > 120_000) throw new Error('Invalid drain deadline.');
  }

  get state(): HostState { return this.current; }
  get blocked(): HostBlocked | undefined { return this.current === 'blocked' && this.blockedRecord ? { ...this.blockedRecord } : undefined; }

  block(error: unknown = new Error('Daemon ownership was lost.'), step: ShutdownStep = 'ownership-lost', retryable = false): void {
    this.generation++; this.pending?.abort.abort(); this.pending = undefined;
    let recoverable = false;
    try { recoverable = retryable && (this.options.canRetry?.() ?? false); } catch {}
    const detail = shutdownDetail(error);
    this.blockedRecord = { recoverable, since: Date.now(), message: shutdownMessage(error), step: detail?.step ?? step,
      ...(detail?.session ? { session: detail.session } : {}), pid: process.pid };
    this.current = 'blocked';
    try { this.options.onBlocked?.(this.blockedRecord, error); } catch {}
    try { this.options.record?.('drain_blocked'); } catch {}
  }

  blockedError(work = false): Error & { code: string } {
    const blocked = this.blockedRecord;
    const recovery = blocked?.recoverable ? work ? 'Retry the stop or restart with force.' : 'Retry with force to finish cleanup.'
      : `Cleanup cannot be retried safely; force-terminate the daemon process ${forceTermination(blocked?.pid ?? process.pid)}.`;
    return commandError('host_blocked', work ? `The daemon is blocked after an incomplete shutdown and refuses new work. ${recovery}`
      : `The daemon is blocked after an incomplete shutdown at ${blocked?.step ?? 'settlement'}: ${blocked?.message ?? 'Shutdown failed.'} ${recovery}`);
  }

  prepare(command: AdmittedCommand): AdmissionOutcome {
    const request = command.request;
    if (request.op !== 'host.stop' && request.op !== 'host.restart') throw commandError('invalid_request');
    assertTargetIdentity(this.options.target, request.params.expected, this.options.identity);
    if (this.current === 'stopped') throw commandError('unavailable');
    if (this.current === 'blocked' && request.params.mode === 'force' && this.blockedRecord?.recoverable) {
      let retryable = false;
      try { retryable = this.options.canRetry?.() ?? false; } catch {}
      if (!retryable) this.blockedRecord = { ...this.blockedRecord, recoverable: false };
    }
    if (this.current === 'blocked' && (request.params.mode !== 'force' || !this.blockedRecord?.recoverable)) throw this.blockedError();
    if (this.completing) throw commandError('busy');
    const action = request.op === 'host.stop' ? 'stop' : 'restart';
    if (this.current === 'draining' && this.pending && (this.pending.action !== action || this.pending.mode === 'force' && request.params.mode !== 'force')) throw commandError('busy');
    command.dispatch(() => {
      try { this.options.beginDrain(); } catch (error) { this.block(error, 'begin-drain'); throw error; }
      if (this.current === 'draining' && this.pending?.action === action && this.pending.mode === request.params.mode) return;
      this.pending?.abort.abort();
      this.pending = { id: request.id, action, mode: request.params.mode, generation: ++this.generation, abort: new AbortController() };
      this.setState('draining');
      try { this.options.record?.(action === 'stop' ? 'stop_requested' : 'restart_requested'); }
      catch (error) { this.block(error, 'begin-drain'); throw error; }
    });
    return { response: accepted(request, { state: this.current }) };
  }

  afterResponse(id: string, accepted = true): void {
    const pending = this.pending;
    if (this.current !== 'draining' || !pending || pending.id !== id) return;
    if (!accepted) { if (!this.resume()) this.block(new Error('Management outcome could not be committed.'), 'management-response'); return; }
    this.pending = { ...pending, id: '' };
    void this.finish(pending);
  }

  private async finish(pending: PendingAction): Promise<void> {
    let releasing = false;
    try {
      await this.settle(pending);
      if (pending.generation !== this.generation || this.current !== 'draining') return;
      releasing = true; this.completing = true;
      this.options.record?.('releasing');
      await this.options.complete(pending.action);
      this.setState('stopped');
    } catch (error) {
      if (pending.generation !== this.generation) return;
      this.completing = false;
      // A drain can reopen admission only before registry shutdown has made resumption unsafe.
      if (!releasing && pending.mode === 'drain' && this.resume()) return;
      this.block(error, releasing ? 'release' : 'settlement', !releasing && !(error instanceof ShutdownError && error.step === 'settlement-deadline'));
    }
  }

  private resume(): boolean {
    this.pending?.abort.abort();
    try { this.options.endDrain(); } catch { return false; }
    this.generation++; this.pending = undefined; this.setState('ready');
    try { this.options.record?.('drain_cancelled'); } catch { /* The daemon keeps serving even if diagnostics fail. */ }
    return true;
  }

  private async settle(pending: PendingAction): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.resolve().then(() => this.options.settle(pending.mode, pending.abort.signal)), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { pending.abort.abort(); reject(new ShutdownError('settlement-deadline', new Error('Settlement deadline exceeded.'))); }, this.timeout);
      })]);
    } finally { clearTimeout(timer); }
  }

  private setState(state: HostState): void { this.current = state; if (state !== 'blocked') this.blockedRecord = undefined; }
}

/** A blocked daemon answers SIGTERM with a drain request, which it refuses, so only a forced termination ends it. */
function forceTermination(pid: number): string {
  return `${pid} (${process.platform === 'win32' ? `taskkill /F /PID ${pid}` : `kill -9 ${pid}`})`;
}
