import type { DaemonIdentity, HostBlocked, HostHeld, OperationParams, OperationResult, Response } from '@felan-ai/session-protocol';
import type { AdmittedCommand, AdmissionOutcome } from './admission.js';
import { accepted, commandError } from './commands.js';
import { assertTargetIdentity, type ResolvedDaemonTarget } from './target.js';
import { ShutdownError, shutdownDetail, shutdownMessage, type ShutdownStep } from './shutdown-error.js';

export type HostState = OperationResult<'host.status'>['state'];
export type HostAction = 'stop' | 'restart';
export type HostMode = OperationParams<'host.stop'>['mode'];
export type SettleMode = Exclude<HostMode, 'hold'>;
export interface HostActivity { runs: number; work: number }
export interface HostLifecycleOptions {
  target: ResolvedDaemonTarget;
  identity: DaemonIdentity;
  beginDrain(): void;
  /** Closes admission and remote claims without interrupting anything, so an idle check cannot race new work. Required for `hold`. */
  holdAdmission?(): void;
  /** Active runs and interruptible work; a `hold` is accepted only when both are zero. Required for `hold`. */
  activity?(): Promise<HostActivity>;
  /**
   * Parks every active run at its next step end and records how to continue it; resolves with the number of held runs once
   * nothing else runs. Rejecting, including when `signal` aborts, leaves no run parked and no record. Without it a hold on
   * a host with an active run answers `busy`.
   */
  holdRuns?(signal: AbortSignal): Promise<number>;
  /**
   * True while the daemon still continues the runs its predecessor held. Closing admission then would interrupt them, so a
   * hold answers `busy` until it is false.
   */
  restoring?(): boolean;
  /** Reopens admission after a drain was abandoned; throws when the daemon can no longer resume. */
  endDrain(): void;
  /** Settlement must stop before releasing anything once `signal` aborts. */
  settle(mode: SettleMode, signal: AbortSignal): Promise<void>;
  complete(action: HostAction): Promise<void>;
  timeoutMs?: number;
  /** How long an accepted hold keeps admission closed without a stop before the daemon reopens it. */
  holdTimeoutMs?: number;
  canRetry?(): boolean;
  onBlocked?(blocked: HostBlocked, error: unknown): void;
  record?(event: 'stop_requested' | 'restart_requested' | 'drain_blocked' | 'drain_cancelled' | 'releasing' | 'hold_started' | 'hold_expired'): void;
}

/** Admission stays closed while activity is counted, so a slow count must not keep the daemon from serving. */
const HOLD_CHECK_MS = 10_000;
/** How long a hold waits for active runs to reach a step end when the request names no limit. */
const STEP_TIMEOUT_MS = 180_000;

interface PendingAction { id: string; action: HostAction; mode: HostMode; generation: number; abort: AbortController; held?: HostHeld }

export class HostLifecycle {
  private current: HostState = 'ready';
  private generation = 0;
  private completing = false;
  private pending: PendingAction | undefined;
  private blockedRecord: HostBlocked | undefined;
  private readonly timeout: number;
  private readonly holdTimeout: number;

  constructor(private readonly options: HostLifecycleOptions) {
    this.timeout = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeout) || this.timeout < 1 || this.timeout > 120_000) throw new Error('Invalid drain deadline.');
    this.holdTimeout = options.holdTimeoutMs ?? 60_000;
    if (!Number.isInteger(this.holdTimeout) || this.holdTimeout < 1 || this.holdTimeout > 600_000) throw new Error('Invalid hold deadline.');
  }

  get state(): HostState { return this.current; }
  get modes(): HostMode[] { return this.options.holdAdmission && this.options.activity ? ['drain', 'force', 'hold'] : ['drain', 'force']; }
  get holdsRuns(): boolean { return this.modes.includes('hold') && this.options.holdRuns !== undefined; }
  get held(): HostHeld | undefined { return this.current === 'draining' && this.pending?.held ? { ...this.pending.held } : undefined; }
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

  prepare(command: AdmittedCommand): AdmissionOutcome | Promise<AdmissionOutcome> {
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
    if (request.params.stepTimeoutMs !== undefined && request.params.mode !== 'hold') throw commandError('invalid_request', 'stepTimeoutMs applies only to mode hold.');
    if (request.params.mode === 'hold') return this.prepareHold(command, action);
    // A held daemon is idle with admission closed, so any drain or force request may replace the hold.
    if (this.current === 'draining' && this.pending && this.pending.mode !== 'hold'
      && (this.pending.action !== action || this.pending.mode === 'force' && request.params.mode !== 'force')) throw commandError('busy');
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

  /**
   * Admission closes before activity is counted, so no run or remote command can start between the idle check and the hold.
   * A busy host reopens admission and answers `busy`; an idle host stays closed until a stop, a restart or the hold deadline.
   */
  private async prepareHold(command: AdmittedCommand, action: HostAction): Promise<AdmissionOutcome> {
    const request = command.request;
    const current = this.pending;
    if (this.current === 'draining' && current?.mode === 'hold' && current.held && current.action === action) {
      command.dispatch(() => {});
      return { response: accepted(request, this.managedResult()) };
    }
    if (this.current !== 'ready') throw commandError('busy', 'The daemon is already stopping or restarting.');
    if (this.options.restoring?.()) throw commandError('busy', 'The daemon is still continuing the runs its previous run held.');
    const { holdAdmission, activity } = this.options;
    if (!holdAdmission || !activity) throw commandError('unavailable', 'This daemon cannot hold admission.');
    const pending: PendingAction = command.dispatch(() => {
      try { holdAdmission(); } catch (error) { this.block(error, 'begin-drain'); throw error; }
      const next: PendingAction = { id: request.id, action, mode: 'hold', generation: ++this.generation, abort: new AbortController() };
      this.pending = next; this.setState('draining');
      return next;
    });
    let observed: HostActivity | undefined; let failure: unknown; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      observed = await Promise.race([activity(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Daemon activity could not be read in time.')), HOLD_CHECK_MS);
      })]);
    } catch (error) { failure = error; } finally { clearTimeout(timer); }
    if (pending.generation !== this.generation) return { response: rejection(request, 'busy', 'Another stop or restart replaced the hold.') };
    if (observed?.runs && this.options.holdRuns) {
      const limit = (request.params as { stepTimeoutMs?: number }).stepTimeoutMs ?? STEP_TIMEOUT_MS;
      return { response: this.awaitRuns(request, pending, action, limit) };
    }
    if (!observed || observed.runs || observed.work) {
      if (!this.reopen()) {
        this.block(new Error('Admission could not reopen after a refused hold.'), 'end-drain');
        return { response: rejection(request, 'host_blocked', 'Admission could not reopen after a refused hold.') };
      }
      return { response: observed ? rejection(request, 'busy', `The daemon has ${observed.runs} active runs and ${observed.work} units of interruptible work; it holds only while idle.`)
        : rejection(request, 'unavailable', failure instanceof Error ? failure.message : 'Daemon activity could not be read.') };
    }
    try { this.options.beginDrain(); } catch (error) { this.block(error, 'begin-drain'); return { response: rejection(request, 'host_blocked', 'The daemon could not close admission.') }; }
    const since = Date.now();
    pending.held = { action, since, until: since + this.holdTimeout, ...(this.options.holdRuns ? { runs: 0 } : {}) };
    return { response: accepted(request, this.managedResult()) };
  }

  /** Waits for every active run to hold at a step end; past `limit` the attempt is cancelled, the runs continue and admission reopens. */
  private async awaitRuns(request: AdmittedCommand['request'], pending: PendingAction, action: HostAction, limit: number): Promise<Response> {
    let expired = false;
    const timer = setTimeout(() => { expired = true; pending.abort.abort(); }, limit);
    try {
      const runs = await this.options.holdRuns!(pending.abort.signal);
      if (pending.generation !== this.generation) return rejection(request, 'busy', 'Another stop or restart replaced the hold.');
      try { this.options.beginDrain(); } catch (error) { this.block(error, 'begin-drain'); return rejection(request, 'host_blocked', 'The daemon could not close admission.'); }
      const since = Date.now();
      pending.held = { action, since, until: since + this.holdTimeout, runs };
      return accepted(request, this.managedResult());
    } catch (error) {
      if (pending.generation !== this.generation) return rejection(request, 'busy', 'Another stop or restart replaced the hold.');
      if (!this.reopen()) {
        this.block(new Error('Admission could not reopen after a cancelled hold.'), 'end-drain');
        return rejection(request, 'host_blocked', 'Admission could not reopen after a cancelled hold.');
      }
      return rejection(request, 'hold_cancelled', expired
        ? `A run did not reach the end of its step within ${limit} ms. The hold was cancelled, held runs continued and admission reopened.`
        : `The hold was cancelled before every run held: ${error instanceof Error ? error.message : 'unknown failure'}`);
    } finally { clearTimeout(timer); }
  }

  afterResponse(id: string, accepted = true): void {
    const pending = this.pending;
    if (this.current !== 'draining' || !pending || pending.id !== id) return;
    if (!accepted) { if (!this.resume()) this.block(new Error('Management outcome could not be committed.'), 'management-response'); return; }
    this.pending = { ...pending, id: '' };
    if (pending.mode === 'hold') { this.expireHold(this.pending); return; }
    void this.finish({ ...pending, mode: pending.mode });
  }

  private expireHold(pending: PendingAction): void {
    try { this.options.record?.('hold_started'); } catch { /* Diagnostics never decide the lifecycle. */ }
    const timer = setTimeout(() => {
      if (this.pending !== pending || pending.generation !== this.generation || this.current !== 'draining') return;
      if (!this.reopen()) { this.block(new Error('Admission could not reopen after the hold expired.'), 'end-drain'); return; }
      try { this.options.record?.('hold_expired'); } catch { /* Diagnostics never decide the lifecycle. */ }
    }, Math.max(0, (pending.held?.until ?? Date.now()) - Date.now()));
    timer.unref?.();
    pending.abort.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  }

  private managedResult(): { state: HostState; held?: HostHeld } {
    const held = this.held;
    return { state: this.current, ...(held ? { held } : {}) };
  }

  private async finish(pending: PendingAction & { mode: SettleMode }): Promise<void> {
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
      this.block(error, releasing ? 'release' : 'settlement', !releasing && !(error instanceof ShutdownError && error.step === 'settlement-deadline'));
    }
  }

  private resume(): boolean {
    if (!this.reopen()) return false;
    try { this.options.record?.('drain_cancelled'); } catch { /* The daemon keeps serving even if diagnostics fail. */ }
    return true;
  }

  private reopen(): boolean {
    this.pending?.abort.abort();
    try { this.options.endDrain(); } catch { return false; }
    this.generation++; this.pending = undefined; this.setState('ready');
    return true;
  }

  private async settle(pending: PendingAction & { mode: SettleMode }): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.resolve().then(() => this.options.settle(pending.mode, pending.abort.signal)), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { pending.abort.abort(); reject(new ShutdownError('settlement-deadline', new Error('Settlement deadline exceeded.'))); }, this.timeout);
      })]);
    } finally { clearTimeout(timer); }
  }

  private setState(state: HostState): void { this.current = state; if (state !== 'blocked') this.blockedRecord = undefined; }
}

function rejection(request: AdmittedCommand['request'], code: string, message: string): Response {
  return { v: 1, re: request.id, outcome: 'rejected', error: { code, message, retryable: false } };
}

/** A blocked daemon answers SIGTERM with a drain request, which it refuses, so only a forced termination ends it. */
function forceTermination(pid: number): string {
  return `${pid} (${process.platform === 'win32' ? `taskkill /F /PID ${pid}` : `kill -9 ${pid}`})`;
}
