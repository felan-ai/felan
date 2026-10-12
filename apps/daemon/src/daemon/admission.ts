import {
  ERROR_CODES, IdSchema, LIMITS, OPERATION_CATALOG, ProtocolValidationError, parseClientEnvelope, parseSchema, parseServerEnvelope, validateRequestId,
  type ClientEnvelope, type Response,
} from '@felan-ai/session-protocol';
import { ControlStoreError, type ControlRequest } from './control-state.js';
import type { DaemonControlStore } from './control-store.js';

export interface AdmissionOptions {
  maxPending?: number;
  maxBytes?: number;
  now?: () => number;
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
export interface AdmissionOutcome { response: Response | Promise<Response> }
export type AdmissionHandler = (command: AdmittedCommand) => AdmissionOutcome | Promise<AdmissionOutcome>;

const safetyOperations = new Set(['cancel', 'agents.cancel', 'interaction.answer', 'processes.stop', 'host.stop', 'host.restart', 'close']);
const safetyBytes = LIMITS.answerBytes + 4096;

export class OrderedAdmission {
  private readonly pending = new Map<string, Promise<Response>>();
  private readonly lanes = new Map<string, Promise<void>>();
  private bytes = 0;
  private duplicateWaiters = 0;
  private readonly maxPending: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(private readonly store: DaemonControlStore, private readonly options: AdmissionOptions = {}) {
    this.maxPending = options.maxPending ?? LIMITS.inflightRequests;
    this.maxBytes = options.maxBytes ?? LIMITS.unsentBytes;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 2 || this.maxPending > LIMITS.inflightRequests
      || !Number.isSafeInteger(this.maxBytes) || this.maxBytes <= safetyBytes || this.maxBytes > LIMITS.unsentBytes) {
      throw new Error('Admission limits must preserve bounded safety capacity.');
    }
  }

  // The caller supplies an already authorized, stable transport principal, not an attachment ID.
  async submit(value: unknown, principal: string, handler?: AdmissionHandler): Promise<Response> {
    this.store.owner.assertCurrent();
    principal = parseSchema(IdSchema, principal);
    const request = parseClientEnvelope(value, { checkFreshness: false });
    if (OPERATION_CATALOG[request.op].storage !== 'durable') {
      throw new ProtocolValidationError('invalid_request', 'Only durable commands enter ordered admission.');
    }
    const bytes = Buffer.byteLength(JSON.stringify(request)) + Buffer.byteLength(principal);
    const safety = safetyOperations.has(request.op);
    const byteLimit = this.maxBytes - (safety ? 0 : safetyBytes);
    const previous = this.store.snapshot().requests.find(item => item.id === request.id);
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
    const admitted = this.store.admit(request, principal);
    this.options.committed?.(admitted.revisions);
    const lane = request.session ?? '';
    const prepared = (this.lanes.get(lane) ?? Promise.resolve()).then(() => this.prepare(request, handler));
    const tail = prepared.then(() => {}, () => {});
    this.lanes.set(lane, tail);
    void tail.then(() => { if (this.lanes.get(lane) === tail) this.lanes.delete(lane); });

    const result = prepared.then(outcome => this.finish(request, outcome)).finally(() => {
      this.pending.delete(request.id); this.bytes -= bytes;
    });
    this.pending.set(request.id, result); this.bytes += bytes;
    return structuredClone(await result);
  }

  private record(id: string): ControlRequest {
    const record = this.store.snapshot().requests.find(item => item.id === id);
    if (!record) throw new ControlStoreError('storage_failure', 'Admitted request identity is missing.');
    return record;
  }

  private retained(record: ControlRequest): Response {
    if (record.phase === 'terminal') return this.savedResponse(record);
    return this.store.finishRequest(record.id, failure(record.id, record.phase === 'dispatch_intent',
      record.phase === 'dispatch_intent' ? 'indeterminate' : 'unavailable')).value;
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
      const state = this.store.snapshot();
      validateRequestId(request.id, Math.max(this.now(), state.clock));
      const record = state.requests.find(item => item.id === request.id);
      if (record?.phase !== 'intent') throw new ControlStoreError('already_resolved', 'Request is no longer undispatched.');
    };
    try {
      const current = this.record(request.id);
      if (current.phase !== 'intent') return { response: this.retained(current) };
      assertDispatch();
      if (!handler) return { response: failure(request.id, false, 'unavailable') };
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
      return { response: this.failedResponse(request.id, error) };
    } finally { dispatchAllowed = false; }
  }

  private async finish(request: ClientEnvelope, outcome: AdmissionOutcome): Promise<Response> {
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
    if (record.phase === 'dispatch_intent') return failure(id, true, 'indeterminate');
    const candidate: unknown = error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
    const code = error instanceof ProtocolValidationError || error instanceof ControlStoreError ? error.code
      : typeof candidate === 'string' && (ERROR_CODES as readonly string[]).includes(candidate) ? candidate : 'unavailable';
    return failure(id, false, code);
  }
}

function failure(id: string, ambiguous: boolean, code: string): Response {
  return { v: 1, re: id, outcome: ambiguous ? 'indeterminate' : 'rejected',
    error: { code, message: 'Operation did not complete. Inspect the current session before retrying.', retryable: false } };
}
