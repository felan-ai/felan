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
  settle(mode: HostMode): Promise<void>;
  complete(action: HostAction): Promise<void>;
  timeoutMs?: number;
  blocked?: boolean;
  allowControl?(): void;
  record?(event: 'stop_requested' | 'restart_requested' | 'drain_blocked' | 'releasing'): void;
}

export class HostLifecycle {
  private current: HostState = 'ready';
  private generation = 0;
  private completing = false;
  private pending: { id: string; action: HostAction; mode: HostMode; generation: number } | undefined;
  private settling: { mode: HostMode; promise: Promise<void> } | undefined;
  private readonly timeout: number;

  constructor(private readonly options: HostLifecycleOptions) {
    if (options.blocked) this.current = 'blocked';
    this.timeout = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeout) || this.timeout < 1 || this.timeout > 120_000) throw new Error('Invalid drain deadline.');
  }

  get state(): HostState { return this.current; }

  block(): void { this.generation++; this.pending = undefined; this.current = 'blocked'; }

  prepare(command: AdmittedCommand): AdmissionOutcome {
    const request = command.request;
    if (request.op !== 'host.stop' && request.op !== 'host.restart') throw commandError('invalid_request');
    assertTargetIdentity(this.options.target, request.params.expected, this.options.identity);
    if (request.params.confirmed !== true) throw commandError('forbidden');
    if (this.current === 'stopped') throw commandError('unavailable');
    if (this.completing) throw commandError('busy');
    this.options.allowControl?.();
    const action = request.op === 'host.stop' ? 'stop' : 'restart';
    if (this.current === 'draining' && this.pending && (this.pending.action !== action || this.pending.mode === 'force' && request.params.mode !== 'force')) throw commandError('busy');
    command.dispatch(() => {
      this.options.beginDrain();
      if (this.current === 'draining' && this.pending?.action === action && this.pending.mode === request.params.mode) return;
      this.pending = { id: request.id, action, mode: request.params.mode, generation: ++this.generation };
      this.setState('draining');
      try { this.options.record?.(action === 'stop' ? 'stop_requested' : 'restart_requested'); }
      catch (error) { this.pending = undefined; this.setState('blocked'); throw error; }
    });
    return { response: accepted(request, { state: this.current }) };
  }

  afterResponse(id: string, accepted = true): void {
    const pending = this.pending;
    if (this.current !== 'draining' || !pending || pending.id !== id) return;
    if (!accepted) { this.pending = undefined; this.setState('blocked'); return; }
    this.pending = { ...pending, id: '' };
    void this.finish(pending);
  }

  private async finish(pending: NonNullable<HostLifecycle['pending']>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!this.settling || this.settling.mode !== pending.mode) {
        const item = { mode: pending.mode, promise: Promise.resolve().then(() => this.options.settle(pending.mode)) };
        this.settling = item;
        void item.promise.then(() => { if (this.settling === item) this.settling = undefined; }, () => { if (this.settling === item) this.settling = undefined; });
      }
      await Promise.race([this.settling.promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Drain deadline exceeded.')), this.timeout);
      })]);
      if (pending.generation !== this.generation || this.current !== 'draining') return;
      this.completing = true;
      this.options.record?.('releasing');
      await this.options.complete(pending.action);
      this.setState('stopped');
    } catch {
      if (pending.generation !== this.generation) return;
      this.completing = false;
      this.setState('blocked');
      try { this.options.record?.('drain_blocked'); } catch { /* Ownership and cleanup stay blocked even if diagnostics fail. */ }
    } finally { clearTimeout(timer); }
  }

  private setState(state: HostState): void { this.current = state; }
}
