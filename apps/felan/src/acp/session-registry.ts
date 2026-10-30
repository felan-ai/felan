import { RequestError, type AgentContext, type ClientCapabilities, type CloseSessionRequest, type LoadSessionRequest, type NewSessionRequest, type PromptRequest, type PromptResponse } from '@agentclientprotocol/sdk';
import { isAbsolute, resolve } from 'node:path';
import { readMessageDisplay, type SessionSnapshot } from '@felan-ai/session-protocol';
import { watchDaemonBuildMismatch } from '../client/build-mismatch.js';
import type { SessionClient } from '../client/client.js';
import { accepted, createDaemonClient, daemonRestartRecovery, DaemonRequestError, readCurrentDaemonHistory, readDaemonHistory, waitForDaemonRun, type DaemonClientOptions } from './daemon-session.js';
import { ACP_UI_CAPABILITIES, AcpProtocolInteractions } from './protocol-interactions.js';
import { AcpProtocolUpdates } from './protocol-updates.js';
import { AcpToolCallIdRegistry, prepareAcpPrompt, sanitizeAcpErrorMessage } from './session-updates.js';

export interface AcpSessionRegistryOptions extends DaemonClientOptions {
  readonly writeDiagnostic?: (message: string) => void;
}

interface ActiveAcpSession {
  readonly sessionId: string;
  readonly updates: AcpProtocolUpdates;
  readonly interactions: AcpProtocolInteractions;
  readonly lifetime: AbortController;
  ready: boolean;
  activePrompt?: Promise<PromptResponse>;
  runId?: string;
  cancelRequested: boolean;
}

export class AcpSessionRegistry {
  readonly #sessions = new Map<string, ActiveAcpSession>();
  readonly #reserved = new Set<string>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #writeDiagnostic: (message: string) => void;
  #supportsForms = false;
  #client: SessionClient | undefined;
  #connecting: Promise<unknown> | undefined;
  #unsubscribe: (() => void) | undefined;
  #stopBuildMismatchWatch: (() => void) | undefined;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(readonly options: AcpSessionRegistryOptions = {}) {
    this.#writeDiagnostic = options.writeDiagnostic ?? (() => {});
  }

  initialize(capabilities: ClientCapabilities): void {
    this.#assertOpen();
    this.#supportsForms = capabilities.elicitation?.form != null;
  }

  newSession(params: NewSessionRequest, client: AgentContext): Promise<{ sessionId: string }> {
    this.#assertOpen();
    return this.#track(async () => {
      const cwd = validateSessionRequest(params);
      const daemon = await this.#connect();
      const { sessionId } = accepted(await daemon.request('sessions.create', { cwd, requirePolicy: 'acp-strict' }));
      await this.#attach(sessionId, cwd, client);
      return { sessionId };
    });
  }

  async loadSession(params: LoadSessionRequest, client: AgentContext): Promise<Record<string, never>> {
    this.#assertOpen();
    if (this.#sessions.has(params.sessionId) || this.#reserved.has(params.sessionId)) throw RequestError.invalidParams({ sessionId: params.sessionId }, 'Session is already active or loading');
    this.#reserved.add(params.sessionId);
    return this.#track(async () => {
      try { await this.#connect(); await this.#attach(params.sessionId, validateSessionRequest(params), client); return {}; }
      finally { this.#reserved.delete(params.sessionId); }
    });
  }

  async #connect(): Promise<SessionClient> {
    this.#assertOpen();
    if (!this.#client) {
      this.#client = await createDaemonClient(this.options, 'acp', this.#supportsForms
        ? ['tool_approval', 'select', 'confirm', 'input', 'editor', 'form', 'dependency'] : ['tool_approval'],
        this.#supportsForms ? [...ACP_UI_CAPABILITIES] : ACP_UI_CAPABILITIES.filter(capability => capability !== 'ui.action'));
      this.#stopBuildMismatchWatch = watchDaemonBuildMismatch(this.#client,
        daemonRestartRecovery(this.options.daemonRuntime), message => this.#writeDiagnostic(message));
      this.#unsubscribe = this.#client.subscribe(() => this.#observe());
      this.#connecting = this.#client.connect();
    } else if (this.#client.status !== 'ready') this.#connecting = this.#client.connect();
    await this.#connecting;
    this.#assertOpen();
    return this.#client;
  }

  async #attach(sessionId: string, cwd: string, client: AgentContext): Promise<void> {
    const daemon = this.#client!;
    let active: ActiveAcpSession | undefined;
    try {
      const { snapshot } = accepted(await daemon.attach(sessionId, { requirePolicy: 'acp-strict' }));
      this.#assertOpen();
      if (!pathsEqual(snapshot.cwd, cwd)) throw RequestError.invalidParams({ sessionId, cwd }, 'Session cwd does not match the persisted session');
      const ids = new AcpToolCallIdRegistry();
      const lifetime = new AbortController();
      const updates = new AcpProtocolUpdates(sessionId, cwd, client, ids, () => !lifetime.signal.aborted && !this.#disposed);
      active = { sessionId, updates, lifetime, ready: false, cancelRequested: false,
        interactions: new AcpProtocolInteractions(daemon, sessionId, client, updates, this.#supportsForms,
          error => this.#writeDiagnostic(sanitizeAcpErrorMessage(error)),
          () => [...this.#sessions.values()].find(session => session.ready && !session.lifetime.signal.aborted)?.sessionId === sessionId) };
      this.#sessions.set(sessionId, active);
      await updates.replay(await readDaemonHistory(daemon, sessionId, snapshot));
      if (lifetime.signal.aborted) throw new Error('Session detached while loading');
      active.ready = true;
      this.#observe();
      await updates.flush();
    } catch (error) {
      if (active) { active.lifetime.abort(); active.interactions.close(); this.#sessions.delete(sessionId); }
      if (daemon.getAttachment(sessionId)) await daemon.detach(sessionId).catch(() => {});
      throw error;
    }
  }

  #observe(): void {
    for (const active of this.#sessions.values()) {
      if (!active.ready || active.lifetime.signal.aborted) continue;
      const attachment = this.#client?.getAttachment(active.sessionId);
      if (attachment?.state.status === 'live' && attachment.state.snapshot) active.updates.observe(attachment.state.snapshot);
      active.interactions.reconcile();
    }
  }

  async prompt(params: PromptRequest, _client: AgentContext): Promise<PromptResponse> {
    const active = this.#require(params.sessionId);
    if (!active.ready) throw RequestError.invalidRequest({ sessionId: params.sessionId }, 'Session is still loading');
    if (active.activePrompt) throw RequestError.invalidRequest({ sessionId: params.sessionId }, 'Only one prompt may run per session');
    const prompt = prepareAcpPrompt(params.prompt);
    active.cancelRequested = false;
    const running = this.#runPrompt(active, prompt.text);
    active.activePrompt = running;
    try { return await running; }
    catch (error) { throw toAcpDaemonError(error); }
    finally { if (active.activePrompt === running) { delete active.activePrompt; delete active.runId; } }
  }

  async #runPrompt(active: ActiveAcpSession, text: string): Promise<PromptResponse> {
    const daemon = this.#client!;
    const { runId } = accepted(await daemon.request('prompt', { text }, { session: active.sessionId }));
    active.runId = runId;
    if (active.cancelRequested) accepted(await daemon.request('cancel', { runId }, { session: active.sessionId }));
    await waitForDaemonRun(daemon, active.sessionId, runId, active.lifetime.signal);
    const { snapshot } = await readCurrentDaemonHistory(daemon, active.sessionId, active.lifetime.signal);
    active.updates.observe(snapshot);
    await active.updates.flush();
    if (active.cancelRequested) return { stopReason: 'cancelled' };
    return { stopReason: stopReason(snapshot) };
  }

  async cancel(sessionId: string): Promise<void> {
    const active = this.#sessions.get(sessionId);
    if (!active || active.lifetime.signal.aborted) return;
    active.cancelRequested = true;
    const runId = active.runId ?? this.#client?.getAttachment(sessionId)?.state.snapshot?.run.id;
    if (runId) {
      try { accepted(await this.#client!.request('cancel', { runId }, { session: sessionId })); }
      catch (error) { throw toAcpDaemonError(error); }
    }
  }

  closeSession(params: CloseSessionRequest): Promise<Record<string, never>> {
    const active = this.#require(params.sessionId);
    this.#sessions.delete(params.sessionId);
    active.lifetime.abort(); active.interactions.close();
    this.#observe();
    return this.#track(async () => { accepted(await this.#client!.detach(params.sessionId)); return {}; });
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#stopBuildMismatchWatch?.();
    this.#unsubscribe?.();
    for (const active of this.#sessions.values()) { active.lifetime.abort(); active.interactions.close(); }
    this.#sessions.clear();
    // Closing only the connection preserves admitted runs and durable pending interactions.
    this.#client?.close();
    this.#disposePromise = Promise.resolve();
    return this.#disposePromise;
  }

  #require(session: string): ActiveAcpSession {
    this.#assertOpen();
    const active = this.#sessions.get(session);
    if (!active) throw RequestError.resourceNotFound(session);
    return active;
  }

  #assertOpen(): void { if (this.#disposed) throw RequestError.internalError(undefined, 'ACP server is closed'); }

  #track<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operation().catch(error => { throw toAcpDaemonError(error); });
    this.#pending.add(pending);
    void pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending));
    return pending;
  }
}

function validateSessionRequest(params: Pick<NewSessionRequest, 'cwd' | 'additionalDirectories'>): string {
  if (!isAbsolute(params.cwd)) throw RequestError.invalidParams({ cwd: params.cwd }, 'cwd must be an absolute path');
  if (params.additionalDirectories?.length) throw RequestError.invalidParams(undefined, 'Additional directories are not supported');
  return resolve(params.cwd);
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
}

function stopReason(snapshot: SessionSnapshot): PromptResponse['stopReason'] {
  if (snapshot.run.state === 'interrupted') return 'cancelled';
  const message = [...snapshot.history.entries].reverse().find(message => message.role === 'assistant');
  const display = readMessageDisplay(message?.details);
  if (display?.kind !== 'assistant') return 'end_turn';
  if (display.stopReason === 'aborted') return 'cancelled';
  if (display.stopReason === 'length') return 'max_tokens';
  if (display.stopReason === 'error') throw RequestError.internalError(undefined, sanitizeAcpErrorMessage(display.errorMessage ?? 'Model request failed'));
  return 'end_turn';
}

function toAcpDaemonError(error: unknown): RequestError {
  if (error instanceof RequestError) return error;
  if (error instanceof DaemonRequestError) {
    const data = { code: error.code, outcome: error.outcome, retryable: error.retryable };
    const message = sanitizeAcpErrorMessage(error.message);
    if (error.code === 'auth_required' || error.code === 'authentication_required') return RequestError.authRequired(data, message);
    if (error.code === 'not_found') return RequestError.resourceNotFound('session');
    if (['busy', 'invalid_request', 'legacy_session'].includes(error.code)) return RequestError.invalidRequest(data, message);
    return RequestError.internalError(data, message);
  }
  return RequestError.internalError(undefined, sanitizeAcpErrorMessage(error));
}
