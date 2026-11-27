import {
  ERROR_CODES, IdSchema, LIMITS, OPERATION_CATALOG, ProtocolValidationError, parseClientEnvelope, parseSchema, parseServerEnvelope,
  type ClientEnvelope, type Response,
} from '@felan-ai/session-protocol';
import { ControlStoreError, type ControlRequest } from './control-state.js';
import type { DaemonControlStore } from './control-store.js';
import { redact } from '../logger.js';

export interface AdmissionOptions {
  maxPending?: number;
  maxBytes?: number;
  committed?(revisions: Readonly<Record<string, number>>): void;
  dispatched?(revisions: Readonly<Record<string, number>>): void;
}

export interface AdmittedCommand {
  readonly request: ClientEnvelope;
  assertDispatch(): void;
  // Registry-managed runs commit their own dispatch; use this only for other effects.
  dispatch<T>(effect: () => T): T;
}

// Returning the response promise separately releases admission without waiting for the turn.
export interface AdmissionOutcome { response: Response | Promise<Response>; withdrawn?: true }

/**
 * Thrown by a handler to forget an undispatched request instead of recording its rejection, so a later submission with
 * the same ID is admitted fresh. A request that already committed dispatch intent keeps its normal outcome.
 */
export class AdmissionWithdrawn extends Error {
  constructor(readonly reason: unknown) { super(reason instanceof Error ? reason.message : 'Admission was withdrawn.'); this.name = 'AdmissionWithdrawn'; }
}

const deferredResponses = new WeakSet<Response>();
/** Marks a rejection issued because admission closed before the request was admitted, so its sender may submit it again later. */
export function deferredResponse(response: Response): Response { deferredResponses.add(response); return response; }
export function isDeferredResponse(response: Response): boolean { return deferredResponses.has(response); }
export type AdmissionHandler = (command: AdmittedCommand) => AdmissionOutcome | Promise<AdmissionOutcome>;

const safetyOperations = new Set(['cancel', 'executions.cancel', 'interaction.answer', 'processes.stop', 'host.stop', 'host.restart', 'close']);
// Backpressure headroom kept free for cancellation, answers and other safety operations.
export const SAFETY_BYTES = 64 * 1024;

export class OrderedAdmission {
  private readonly pending = new Map<string, Promise<Response>>();
  private readonly lanes = new Map<string, Promise<void>>();
  private bytes = 0;
  private duplicateWaiters = 0;
  private readonly maxPending: number;
  private readonly maxBytes: number;

  constructor(private readonly store: DaemonControlStore, private readonly options: AdmissionOptions = {}) {
    this.maxPending = options.maxPending ?? LIMITS.inflightRequests;
    this.maxBytes = options.maxBytes ?? LIMITS.unsentBytes;
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 2 || this.maxPending > LIMITS.inflightRequests
      || !Number.isSafeInteger(this.maxBytes) || this.maxBytes <= SAFETY_BYTES || this.maxBytes > LIMITS.unsentBytes) {
      throw new Error('Admission limits must preserve bounded safety capacity.');
    }
  }

  // The caller supplies an already authorized, stable transport principal, not an attachment ID.
  async submit(value: unknown, principal: string, handler?: AdmissionHandler, committed = this.options.committed): Promise<Response> {
    this.store.owner.assertCurrent();
    principal = parseSchema(IdSchema, principal);
    const request = parseClientEnvelope(value);
    if (OPERATION_CATALOG[request.op].storage !== 'durable') {
      throw new ProtocolValidationError('invalid_request', 'Only durable commands enter ordered admission.');
    }
    const bytes = Buffer.byteLength(JSON.stringify(request)) + Buffer.byteLength(principal);
    const safety = safetyOperations.has(request.op);
    const byteLimit = this.maxBytes - (safety ? 0 : SAFETY_BYTES);
    const previous = this.store.request(request.id);
    if (previous) {
      const record = this.store.admit(request, principal).value;
      const pending = this.pending.get(request.id);
      if (!pending) return this.retained(record);
      if (this.duplicateWaiters >= this.maxPending || this.bytes + bytes > byteLimit) {
        throw new ControlStoreError('request_capacity', 'Too many retries are awaiting their original outcome.');
      }
      this.duplicateWaiters++; this.bytes += bytes;
      try { return structuredClone(await pending); }
      finally { this.duplicateWaiters--; this.bytes -= bytes; }
    }

    if (this.pending.size >= this.maxPending - (safety ? 0 : 1)
      || this.bytes + bytes > byteLimit) {
      throw new ControlStoreError('request_capacity', 'Admission capacity reached; retry after pending work settles.');
    }
    this.store.admit(request, principal, revisions => committed?.(revisions));
    const lane = request.session ?? '';
    const prepared = (this.lanes.get(lane) ?? Promise.resolve()).then(() => this.prepare(request, handler));
    const tail = prepared.then(() => {}, () => {});
    this.lanes.set(lane, tail);
    void tail.then(() => { if (this.lanes.get(lane) === tail) this.lanes.delete(lane); });

    const result: Promise<Response> = prepared.then(outcome => this.finish(request, outcome)).finally(() => {
      // A withdrawn request can be resubmitted under the same ID before this settles; keep the newer entry.
      if (this.pending.get(request.id) === result) this.pending.delete(request.id);
      this.bytes -= bytes;
    });
    this.pending.set(request.id, result); this.bytes += bytes;
    return structuredClone(await result);
  }

  private record(id: string): ControlRequest {
    const record = this.store.request(id);
    if (!record) throw new ControlStoreError('storage_failure', 'Admitted request identity is missing.');
    return record;
  }

  private retained(record: ControlRequest): Response {
    if (record.phase === 'terminal') return this.savedResponse(record);
    return this.store.finishRequest(record.id, record.phase === 'dispatch_intent' ? indeterminate(record.id)
      : failure(record.id, 'unavailable', 'The daemon stopped before this request was dispatched.')).value;
  }

  private savedResponse(record: ControlRequest): Response {
    const response = parseServerEnvelope(record.response, record.op as ClientEnvelope['op']) as Response;
    if (!('re' in response) || response.re !== record.id) throw new ControlStoreError('storage_failure', 'Stored outcome identity is invalid.');
    return response;
  }

  private async prepare(request: ClientEnvelope, handler?: AdmissionHandler): Promise<AdmissionOutcome> {
    let dispatchAllowed = true;
    const assertDispatch = () => {
      if (!dispatchAllowed) throw new Error('Dispatch must start before admission completes.');
      const record = this.store.request(request.id);
      if (record?.phase !== 'intent') throw new ControlStoreError('already_resolved', 'Request is no longer undispatched.');
    };
    try {
      const current = this.record(request.id);
      if (current.phase !== 'intent') return { response: this.retained(current) };
      assertDispatch();
      if (!handler) return { response: failure(request.id, 'unavailable', 'No handler is available for this operation.') };
      const outcome = await handler({ request: structuredClone(request), assertDispatch, dispatch: effect => {
        assertDispatch();
        const commit = this.store.markDispatched(request.id);
        (this.options.dispatched ?? this.options.committed)?.(commit.revisions);
        this.store.owner.assertCurrent();
        return effect();
      } });
      this.store.owner.assertCurrent();
      return outcome;
    } catch (error) {
      if (error instanceof AdmissionWithdrawn) {
        if (this.store.request(request.id)?.phase === 'intent') {
          this.store.withdrawRequest(request.id);
          return { response: failure(request.id, codeOf(error.reason), diagnosticMessage(error.reason)), withdrawn: true };
        }
        return { response: this.failedResponse(request.id, error.reason) };
      }
      return { response: this.failedResponse(request.id, error) };
    } finally { dispatchAllowed = false; }
  }

  private async finish(request: ClientEnvelope, outcome: AdmissionOutcome): Promise<Response> {
    if (outcome.withdrawn) return outcome.response;
    let response: Response;
    try {
      const parsed = parseServerEnvelope(await outcome.response, request.op);
      if (!('re' in parsed) || parsed.re !== request.id) {
        throw new ProtocolValidationError('invalid_request', 'Outcome must identify its admitted request.');
      }
      response = parsed;
      if (response.outcome === 'accepted' && this.record(request.id).phase === 'intent') {
        throw new ProtocolValidationError('invalid_request', 'Acceptance requires committed dispatch intent.');
      }
    } catch (error) { response = this.failedResponse(request.id, error); }
    const current = this.record(request.id);
    if (current.phase === 'terminal') return this.savedResponse(current);
    return this.store.finishRequest(request.id, response).value;
  }

  private failedResponse(id: string, error: unknown): Response {
    const record = this.record(id);
    if (record.phase === 'terminal') return this.savedResponse(record);
    if (record.phase === 'dispatch_intent') return indeterminate(id);
    return failure(id, codeOf(error), diagnosticMessage(error));
  }
}

function codeOf(error: unknown): string {
  const candidate: unknown = error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  return error instanceof ProtocolValidationError || error instanceof ControlStoreError ? error.code
    : typeof candidate === 'string' && (candidate === 'host_blocked' || (ERROR_CODES as readonly string[]).includes(candidate)) ? candidate : 'unavailable';
}

/** Wire-safe text of an error; diagnostics are single-line, bounded by the protocol and never quote credentials or parsed file content. */
export function diagnosticMessage(error: unknown): string {
  const message = error instanceof SyntaxError ? 'A file or response contains invalid JSON.' : error instanceof Error ? redact(error.message) : '';
  const flat = message.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ').trim();
  if (!flat) return 'Operation could not be completed.';
  const bytes = Buffer.from(flat);
  return bytes.length <= 4096 ? flat : `${bytes.subarray(0, 4090).toString('utf8').replace(/\uFFFD+$/u, '')}…`;
}

function failure(id: string, code: string, message: string): Response {
  return { v: 1, re: id, outcome: 'rejected', error: { code, message, retryable: false } };
}

function indeterminate(id: string): Response {
  return { v: 1, re: id, outcome: 'indeterminate',
    error: { code: 'indeterminate', message: 'The operation started but its outcome is unknown. Inspect the current session before retrying.', retryable: false } };
}
