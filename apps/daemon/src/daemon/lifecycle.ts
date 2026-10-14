import type { DaemonIdentity, OperationParams, OperationResult } from '@felan-ai/session-protocol';
import type { AdmittedCommand, AdmissionOutcome } from './admission.js';
import { accepted, commandError } from './commands.js';
import { assertTargetIdentity, type ResolvedDaemonTarget } from './target.js';

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
  record?(event: 'stop_requested' | 'restart_requested' | 'drain_blocked' | 'drain_cancelled' | 'releasing'): void;
}

interface PendingAction { id: string; action: HostAction; mode: HostMode; generation: number; abort: AbortController }

export class HostLifecycle {
  private current: HostState = 'ready';
  private generation = 0;
  private completing = false;
  private pending: PendingAction | undefined;
  private readonly timeout: number;

  constructor(private readonly options: HostLifecycleOptions) {
    this.timeout = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeout) || this.timeout < 1 || this.timeout > 120_000) throw new Error('Invalid drain deadline.');
  }

  get state(): HostState { return this.current; }

  block(): void { this.generation++; this.pending?.abort.abort(); this.pending = undefined; this.current = 'blocked'; }

  prepare(command: AdmittedCommand): AdmissionOutcome {
    const request = command.request;
    if (request.op !== 'host.stop' && request.op !== 'host.restart') throw commandError('invalid_request');
    assertTargetIdentity(this.options.target, request.params.expected, this.options.identity);
    if (this.current === 'stopped') throw commandError('unavailable');
    if (this.completing) throw commandError('busy');
    const action = request.op === 'host.stop' ? 'stop' : 'restart';
    if (this.current === 'draining' && this.pending && (this.pending.action !== action || this.pending.mode === 'force' && request.params.mode !== 'force')) throw commandError('busy');
    command.dispatch(() => {
      this.options.beginDrain();
      if (this.current === 'draining' && this.pending?.action === action && this.pending.mode === request.params.mode) return;
      this.pending?.abort.abort();
      this.pending = { id: request.id, action, mode: request.params.mode, generation: ++this.generation, abort: new AbortController() };
      this.setState('draining');
      try { this.options.record?.(action === 'stop' ? 'stop_requested' : 'restart_requested'); }
      catch (error) { this.pending = undefined; this.setState('blocked'); throw error; }
    });
    return { response: accepted(request, { state: this.current }) };
  }

  afterResponse(id: string, accepted = true): void {
    const pending = this.pending;
    if (this.current !== 'draining' || !pending || pending.id !== id) return;
    if (!accepted) { if (!this.resume()) this.setState('blocked'); return; }
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
    } catch {
      if (pending.generation !== this.generation) return;
      this.completing = false;
      // Only an explicit force request interrupts work; a drain that cannot finish is abandoned and the daemon keeps serving.
      if (!releasing && pending.mode === 'drain' && this.resume()) return;
      this.setState('blocked');
      try { this.options.record?.('drain_blocked'); } catch { /* Ownership and cleanup stay blocked even if diagnostics fail. */ }
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
        timer = setTimeout(() => { pending.abort.abort(); reject(new Error('Settlement deadline exceeded.')); }, this.timeout);
      })]);
    } finally { clearTimeout(timer); }
  }

  private setState(state: HostState): void { this.current = state; }
}
