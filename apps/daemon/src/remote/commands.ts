import { createHash } from 'node:crypto';
import { ERROR_CODES, parseClientEnvelope, parseRemoteCommand, parseRemoteCommandOutcome, requestTimestamp,
  type ClientEnvelope, type HostCapabilities, type HostProject, type RemoteCommand, type RemoteCommandOutcome, type Response } from '@felan-ai/session-protocol';
import { commandError } from '../daemon/commands.js';
import type { CommandJournal, RemoteCommandJournalEntry } from './command-journal.js';
import { systemClock, type RemoteClock } from './backoff.js';
import type { RemoteSubmission } from '../daemon/server.js';

export type ClaimedRemoteCommand = { id: string; requester?: string; command: RemoteCommand; expiresAt: number; claimedAt?: number; channel?: RemoteChannel; automation?: { source: string } } | { id: string; invalid: string };
export interface RemoteChannel { provider: string }
export interface CommandClaimBatch { startedAt: number; receivedAt: number }
export type RemoteHostIdentity = { kind: 'personal'; userId: string } | { kind: 'team' };
export interface RemoteCommandDependencies {
  submit(request: ClientEnvelope, remote: RemoteSubmission): Promise<Response>;
  lookup(id: string): boolean;
  hostIdentity(): RemoteHostIdentity | undefined;
  clock?: Pick<RemoteClock, 'now'>;
  /** Projects explicitly opened and trusted by the local user, not arbitrary cwd values. */
  projects(): HostProject[];
  isShared(session: string): boolean;
  markWebCreated(session: string): void;
  capabilities: HostCapabilities;
  journal: CommandJournal;
  unrecordedIsIndeterminate?(): boolean;
}

export class RemoteCommandExecutor {
  private readonly pending = new Map<string, Promise<RemoteCommandOutcome>>();
  constructor(private readonly options: RemoteCommandDependencies) {}

  execute(row: ClaimedRemoteCommand, batch?: CommandClaimBatch): Promise<RemoteCommandOutcome> {
    const now = batch?.receivedAt ?? (this.options.clock ?? systemClock).now();
    const claim = batch ?? { startedAt: now, receivedAt: now };
    // Serialize duplicate claims without letting a conflicting payload inherit the first caller's outcome.
    const key = row.id.toLowerCase();
    const previous = this.pending.get(key);
    const work = (previous ? previous.catch(() => {}) : Promise.resolve()).then(() => this.run(row, claim));
    this.pending.set(key, work);
    void work.finally(() => { if (this.pending.get(key) === work) this.pending.delete(key); }).catch(() => {});
    return work;
  }

  forget(id: string): void { this.options.journal.forget(id); }

  private async run(row: ClaimedRemoteCommand, batch: CommandClaimBatch): Promise<RemoteCommandOutcome> {
    requestTimestamp(row.id);
    const host = this.options.hostIdentity();
    if (!host) throw commandError('unavailable', 'Host identity is unavailable.');
    const id = row.id.toLowerCase();
    let identity = createHash('sha256').update(JSON.stringify(row)).digest('hex');
    let entry = this.options.journal.get(id);
    if (!entry && this.options.unrecordedIsIndeterminate?.()) {
      if (!('invalid' in row)) identity = commandIdentity(row.requester?.toLowerCase(), row.command, row.channel, row.automation);
      return this.complete(id, identity, failure(id, 'indeterminate', 'Remote command journal was lost. Inspect the session before retrying.'));
    }
    try {
      let command: RemoteCommand;
      let requester: string | undefined;
      if ('invalid' in row) {
        if (entry) return entry.identity === identity && entry.state === 'completed' ? entry.outcome : failure(id, 'request_conflict', 'Remote command identity changed.');
        throw commandError('invalid_request', 'Invalid remote command row.');
      }
      if (row.requester !== undefined && !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(row.requester)) throw commandError('invalid_request');
      requester = row.requester?.toLowerCase(); command = parseRemoteCommand(row.command);
      identity = commandIdentity(requester, command, row.channel, row.automation);
      if (entry && entry.identity !== identity) return failure(id, 'request_conflict', 'Remote command identity changed.');
      if (host.kind === 'personal' && requester !== host.userId.toLowerCase()) {
        const outcome = failure(id, 'forbidden', 'Remote commands require the host owner.');
        return entry ? outcome : this.complete(id, identity, outcome);
      }
      if (entry?.state === 'completed') return entry.outcome;
      // A fresh server claim already won the expiry race; batch processing time must not undo it.
      const previouslyClaimed = row.claimedAt === undefined || row.claimedAt < batch.startedAt - 5_000;
      if (!entry && previouslyClaimed && row.expiresAt <= batch.receivedAt - 5_000) {
        return this.complete(id, identity, failure(id, 'expired', 'Remote command expired before admission.'));
      }
      const replay = entry !== undefined;
      if (!this.options.capabilities.operations.includes(command.op)) throw commandError('forbidden', 'Remote operation is not advertised by this host.');
      if (command.op === 'sessions.create' && command.params.prompt && !this.options.capabilities.operations.includes('prompt')) throw commandError('forbidden');
      if (command.op !== 'sessions.create' && !this.options.isShared(command.session)) throw commandError('forbidden', 'Session is not shared.');
      if (!entry) {
        const request = this.map(id, command);
        const dispatching: RemoteCommandJournalEntry = { id, identity, state: 'dispatching', request };
        this.options.journal.write(dispatching);
        entry = dispatching;
      }
      const remote: RemoteSubmission = { ...(requester ? { user: requester } : {}), command: id,
        ...(row.channel ? { channel: row.channel } : {}), ...(row.automation ? { automation: row.automation } : {}),
        ...(command.op === 'sessions.create' && command.params.sessionId ? { sessionId: command.params.sessionId } : {}),
        interactionKinds: this.options.capabilities.interactionKinds };
      let response = await this.submit(entry, remote, replay);
      if (response.outcome === 'accepted' && command.op === 'sessions.create') {
        const session = entry.createdSession ?? ('sessionId' in response.result ? response.result.sessionId : undefined);
        if (typeof session !== 'string') throw commandError('indeterminate');
        this.options.markWebCreated(session);
        if (command.params.prompt && !entry.createdSession) {
          const prompt = parseClientEnvelope({ v: 1, id: remotePromptRequestId(id), op: 'prompt', session, params: command.params.prompt });
          const dispatching: RemoteCommandJournalEntry = { id, identity, state: 'dispatching', request: prompt, createdSession: session };
          this.options.journal.write(dispatching);
          entry = dispatching;
          const { sessionId: _, ...promptRemote } = remote;
          response = await this.options.submit(prompt, promptRemote);
        }
        if (response.outcome === 'accepted') return this.complete(id, identity, { v: 1, re: id, outcome: 'accepted', result: { sessionId: session } } as RemoteCommandOutcome);
      }
      return this.complete(id, identity, { ...response, re: id });
    } catch (error) {
      const candidate = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const code = typeof candidate === 'string' && (ERROR_CODES as readonly string[]).includes(candidate) ? candidate : 'unavailable';
      if (entry && entry.identity !== identity) return failure(id, 'request_conflict', 'Remote command identity changed.');
      if (entry?.state === 'completed') return entry.outcome;
      if (entry?.state === 'dispatching') return this.complete(id, identity, failure(id, 'indeterminate', 'Remote command outcome is unknown. Inspect the session before retrying.'));
      return this.complete(id, identity, failure(id, code, 'Remote command was rejected.'));
    }
  }

  private async submit(entry: Extract<RemoteCommandJournalEntry, { state: 'dispatching' }>, remote: RemoteSubmission, replay: boolean): Promise<Response> {
    if (replay && !this.options.lookup(entry.request.id)) return failure(entry.id, 'indeterminate', 'The admitted request is no longer retained.');
    const { sessionId, ...context } = remote;
    return this.options.submit(entry.request, { ...context, ...(entry.request.op === 'sessions.create' && sessionId ? { sessionId } : {}),
      ...(replay ? { requireRetained: true } : {}) });
  }

  private map(id: string, command: RemoteCommand): ClientEnvelope {
    if (command.op !== 'sessions.create') return parseClientEnvelope({ v: 1, id, ...command });
    const project = this.options.projects().find(project => project.id === command.params.project);
    if (!project) throw commandError('not_found', 'Project is not open for remote sessions.');
    return parseClientEnvelope({ v: 1, id, op: 'sessions.create', params: { cwd: project.path,
      ...(command.params.model ? { model: command.params.model } : {}), ...(command.params.thinking ? { thinking: command.params.thinking } : {}),
      ...(command.params.instructions ? { instructions: command.params.instructions } : {}) } });
  }

  private complete(id: string, identity: string, outcome: RemoteCommandOutcome): RemoteCommandOutcome {
    parseRemoteCommandOutcome(outcome);
    try { this.options.journal.write({ id, identity, state: 'completed', outcome }); }
    catch (error) {
      if (outcome.outcome !== 'rejected' || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'request_capacity') throw error;
      return failure(id, 'request_capacity', 'Remote command was rejected.');
    }
    return outcome;
  }
}

function commandIdentity(requester: string | undefined, command: RemoteCommand, channel: RemoteChannel | undefined, automation: { source: string } | undefined): string {
  return createHash('sha256').update(canonical({ ...(requester ? { requester } : {}), command, ...(channel ? { channel } : {}), ...(automation ? { automation } : {}) })).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function remotePromptRequestId(command: string): string {
  requestTimestamp(command);
  const digest = createHash('sha256').update(`remote-initial-prompt:${command.toLowerCase()}`).digest('hex');
  return `${command.slice(0, 14).toLowerCase()}7${digest.slice(0, 3)}-8${digest.slice(3, 6)}-${digest.slice(6, 18)}`;
}

function failure(id: string, code: string, message: string): Response {
  return parseRemoteCommandOutcome({ v: 1, re: id, outcome: code === 'indeterminate' ? 'indeterminate' : 'rejected', error: { code, message, retryable: false } }) as Response;
}
