import {
  RequestError,
  type AgentContext,
  type ClientCapabilities,
  type CloseSessionRequest,
  type LoadSessionRequest,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
} from '@agentclientprotocol/sdk';
import {
  SessionManager,
  type AgentSession,
  type ModelRuntime,
} from '@felan-ai/agent-core';
import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  createLocalFelanRuntime,
  createLocalModelRuntime,
  getLocalAgentDir,
  type CreateLocalFelanRuntimeOptions,
  type LocalFelanRuntime,
} from '../runtime.js';
import { createLocalSettingsManager } from '../settings.js';
import {
  AcpPromptUpdateStream,
  AcpToolCallIdRegistry,
  prepareAcpPrompt,
  replayAcpSessionEntries,
  sanitizeAcpErrorMessage,
  toAcpPromptError,
  type PreparedAcpPrompt,
} from './session-updates.js';
import { AcpSessionInteractions } from './interactions.js';

const AUTHENTICATION_REFRESH_TIMEOUT_MS = 15_000;

export type AcpRuntimeFactory = (
  options: CreateLocalFelanRuntimeOptions,
) => Promise<LocalFelanRuntime>;

export interface AcpSessionRegistryOptions {
  readonly agentDir?: string;
  readonly createModelRuntime?: (agentDir: string) => Promise<ModelRuntime>;
  readonly createRuntime?: AcpRuntimeFactory;
  readonly writeDiagnostic?: (message: string) => void;
  readonly openSession?: (
    sessionId: string,
    cwd: string,
    agentDir: string,
  ) => Promise<SessionManager | undefined>;
}

interface ActiveAcpSession {
  readonly runtime: LocalFelanRuntime;
  readonly interactions: AcpSessionInteractions;
  client: AgentContext;
  activePrompt?: Promise<PromptResponse>;
  closePromise?: Promise<void>;
  cancelRequested: boolean;
  closed: boolean;
  nextPromptTurn: number;
  readonly toolCallIds: AcpToolCallIdRegistry;
}

class AcpRuntimeCleanupError extends AggregateError {
  constructor(errors: readonly unknown[], message: string) {
    super(errors, message);
    this.name = 'AcpRuntimeCleanupError';
  }
}

export class AcpSessionRegistry {
  readonly #agentDir: string;
  readonly #createModelRuntime: (agentDir: string) => Promise<ModelRuntime>;
  #modelRuntime: Promise<ModelRuntime> | undefined;
  readonly #createRuntime: AcpRuntimeFactory;
  readonly #writeDiagnostic: (message: string) => void;
  readonly #openSession: NonNullable<AcpSessionRegistryOptions['openSession']>;
  readonly #sessions = new Map<string, ActiveAcpSession>();
  readonly #loadingSessions = new Map<string, ActiveAcpSession>();
  readonly #reservedSessionIds = new Set<string>();
  readonly #closingSessionIds = new Set<string>();
  readonly #pendingLifecycle = new Set<Promise<void>>();
  readonly #cleanupFailures = new Set<unknown>();
  #disposePromise: Promise<void> | undefined;
  #disposed = false;
  #supportsFormElicitation = false;

  constructor(options: AcpSessionRegistryOptions = {}) {
    this.#agentDir = resolve(options.agentDir ?? getLocalAgentDir());
    this.#createRuntime = options.createRuntime ?? createLocalFelanRuntime;
    this.#writeDiagnostic = options.writeDiagnostic ?? (() => {});
    this.#openSession = options.openSession ?? openPersistedSession;
    this.#createModelRuntime = options.createModelRuntime ?? createLocalModelRuntime;
  }

  initialize(capabilities: ClientCapabilities): void {
    this.#assertOpen();
    this.#supportsFormElicitation = capabilities.elicitation?.form != null;
  }

  newSession(params: NewSessionRequest, client: AgentContext): Promise<{ sessionId: string }> {
    this.#assertOpen();
    return this.#trackLifecycle(this.#newSession(params, client));
  }

  async #newSession(params: NewSessionRequest, client: AgentContext): Promise<{ sessionId: string }> {
    const request = await validateSessionRequest(params);
    const toolCallIds = new AcpToolCallIdRegistry();
    const { runtime, interactions } = await this.#createSession(
      request.cwd,
      client,
      toolCallIds,
    );
    try {
      const sessionId = runtime.session.sessionManager.getSessionId();
      this.#assertOpen();
      if (
        this.#sessions.has(sessionId)
        || this.#reservedSessionIds.has(sessionId)
        || this.#closingSessionIds.has(sessionId)
      ) {
        throw RequestError.internalError({ sessionId }, 'A duplicate session ID was created');
      }
      this.#sessions.set(sessionId, {
        runtime,
        interactions,
        client,
        cancelRequested: false,
        closed: false,
        nextPromptTurn: 0,
        toolCallIds,
      });
      return { sessionId };
    } catch (error) {
      interactions.close();
      return disposeRuntimeAfterFailure(runtime, error, 'Failed to discard an unregistered ACP session');
    }
  }

  loadSession(params: LoadSessionRequest, client: AgentContext): Promise<Record<string, never>> {
    this.#assertOpen();
    if (this.#sessions.has(params.sessionId)) {
      throw RequestError.invalidParams({ sessionId: params.sessionId }, 'Session is already active');
    }
    if (this.#reservedSessionIds.has(params.sessionId)) {
      throw RequestError.invalidParams({ sessionId: params.sessionId }, 'Session is already loading');
    }
    if (this.#closingSessionIds.has(params.sessionId)) {
      throw RequestError.invalidParams({ sessionId: params.sessionId }, 'Session is closing');
    }
    this.#reservedSessionIds.add(params.sessionId);
    return this.#trackLifecycle(this.#loadSession(params, client));
  }

  async #loadSession(
    params: LoadSessionRequest,
    client: AgentContext,
  ): Promise<Record<string, never>> {
    let active: ActiveAcpSession | undefined;
    try {
      const request = await validateSessionRequest(params);
      const { cwd } = request;
      const sessionManager = await this.#openSession(params.sessionId, cwd, this.#agentDir);
      if (!sessionManager || sessionManager.getSessionId() !== params.sessionId) {
        throw RequestError.resourceNotFound(params.sessionId);
      }
      if (!pathsEqual(sessionManager.getCwd(), cwd)) {
        throw RequestError.invalidParams(
          { sessionId: params.sessionId, cwd },
          'Session cwd does not match the persisted session',
        );
      }
      const toolCallIds = new AcpToolCallIdRegistry();
      const { runtime, interactions } = await this.#createSession(
        cwd,
        client,
        toolCallIds,
        sessionManager,
      );
      if (runtime.session.sessionManager.getSessionId() !== params.sessionId) {
        interactions.close();
        return disposeRuntimeAfterFailure(
          runtime,
          RequestError.internalError(
            { sessionId: params.sessionId },
            'Felan runtime opened a different session',
          ),
          'Failed to discard a mismatched ACP session',
        );
      }
      if (this.#sessions.has(params.sessionId)) {
        interactions.close();
        return disposeRuntimeAfterFailure(
          runtime,
          RequestError.invalidParams({ sessionId: params.sessionId }, 'Session is already active'),
          'Failed to discard a duplicate ACP session',
        );
      }
      const createdActive: ActiveAcpSession = {
        runtime,
        interactions,
        client,
        cancelRequested: false,
        closed: false,
        nextPromptTurn: 0,
        toolCallIds,
      };
      active = createdActive;
      this.#loadingSessions.set(params.sessionId, createdActive);
      await replayAcpSessionEntries(
        params.sessionId,
        cwd,
        runtime.session.sessionManager.getBranch(),
        client,
        () => this.#loadingSessions.get(params.sessionId) === createdActive && !createdActive.closed,
        createdActive.toolCallIds,
      );
      if (this.#loadingSessions.get(params.sessionId) !== createdActive || createdActive.closed) {
        throw RequestError.requestCancelled(
          { sessionId: params.sessionId },
          'Session closed while loading',
        );
      }
      this.#loadingSessions.delete(params.sessionId);
      this.#sessions.set(params.sessionId, createdActive);
      return {};
    } catch (error) {
      if (active !== undefined) {
        if (this.#loadingSessions.get(params.sessionId) === active) {
          this.#loadingSessions.delete(params.sessionId);
        }
        try {
          await closeActiveSession(active);
        } catch (cleanupError) {
          throw new AcpRuntimeCleanupError(
            [error, cleanupError],
            'ACP session load and cleanup both failed',
          );
        }
      }
      throw error;
    } finally {
      this.#reservedSessionIds.delete(params.sessionId);
    }
  }

  async prompt(params: PromptRequest, client: AgentContext): Promise<PromptResponse> {
    const active = this.#require(params.sessionId);
    if (active.activePrompt) {
      throw RequestError.invalidRequest(
        { sessionId: params.sessionId },
        'Only one prompt may run per session',
      );
    }
    const preparedPrompt = prepareAcpPrompt(params.prompt);
    active.client = client;
    active.cancelRequested = false;
    active.interactions.beginPrompt(client);
    active.nextPromptTurn += 1;
    const running = this.#runPrompt(active, params, preparedPrompt, active.nextPromptTurn);
    active.activePrompt = running;
    try {
      return await running;
    } finally {
      if (active.activePrompt === running) delete active.activePrompt;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const active = this.#sessions.get(sessionId);
    if (!active || active.closed) return;
    active.cancelRequested = true;
    active.interactions.cancelPending();
    await active.runtime.session.abort();
  }

  closeSession(params: CloseSessionRequest): Promise<Record<string, never>> {
    this.#assertOpen();
    if (this.#loadingSessions.has(params.sessionId)) {
      throw RequestError.invalidRequest({ sessionId: params.sessionId }, 'Session is still loading');
    }
    const active = this.#sessions.get(params.sessionId);
    if (!active) throw RequestError.resourceNotFound(params.sessionId);
    this.#sessions.delete(params.sessionId);
    this.#closingSessionIds.add(params.sessionId);
    return this.#trackLifecycle(this.#closeSession(params.sessionId, active));
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = this.#performDispose();
    return this.#disposePromise;
  }

  async #performDispose(): Promise<void> {
    const active = [...this.#sessions.values(), ...this.#loadingSessions.values()];
    this.#sessions.clear();
    this.#loadingSessions.clear();
    const pendingLifecycle = [...this.#pendingLifecycle];
    const results = await Promise.allSettled(active.map(closeActiveSession));
    await Promise.all(pendingLifecycle);
    const failures = new Set(this.#cleanupFailures);
    for (const result of results) {
      if (result.status === 'rejected') failures.add(result.reason);
    }
    if (failures.size > 0) throw new AggregateError(failures, 'Failed to close ACP sessions');
  }

  #getModelRuntime(): Promise<ModelRuntime> {
    this.#modelRuntime ??= this.#createModelRuntime(this.#agentDir);
    return this.#modelRuntime;
  }

  async #createSession(
    cwd: string,
    client: AgentContext,
    toolCallIds: AcpToolCallIdRegistry,
    sessionManager?: SessionManager,
  ): Promise<{
    readonly runtime: LocalFelanRuntime;
    readonly interactions: AcpSessionInteractions;
  }> {
    const interactions = new AcpSessionInteractions({
      client,
      supportsFormElicitation: this.#supportsFormElicitation,
      toolCallIds,
    });
    let runtime: LocalFelanRuntime | undefined;
    try {
      this.#assertOpen();
      const modelRuntime = await this.#getModelRuntime();
      this.#assertOpen();
      await requireConfiguredAuthentication(modelRuntime);
      this.#assertOpen();
      runtime = await this.#createRuntime({
        cwd,
        agentDir: this.#agentDir,
        modelRuntime,
        inlineExtensions: [interactions.inlineExtension],
        ...(interactions.uiContext === undefined
          ? {}
          : { subagentUiContext: interactions.uiContext }),
        ...(sessionManager === undefined ? {} : { sessionManager }),
      });
      this.#assertOpen();
      for (const diagnostic of runtime.diagnostics) {
        if (diagnostic.type !== 'info') {
          this.#writeDiagnostic(sanitizeAcpErrorMessage(diagnostic.message));
        }
      }
      const errors = runtime.diagnostics.filter(({ type }) => type === 'error');
      if (errors.length > 0) {
        throw RequestError.internalError(
          { diagnostics: errors.map(({ message }) => sanitizeAcpErrorMessage(message)) },
          'Felan runtime could not start',
        );
      }
      interactions.bindSession(runtime.session.sessionManager.getSessionId());
      await runtime.session.bindExtensions(interactions.uiContext === undefined
        ? { mode: 'rpc' }
        : { mode: 'rpc', uiContext: interactions.uiContext });
      this.#assertOpen();
      return { runtime, interactions };
    } catch (error) {
      interactions.close();
      if (runtime === undefined) throw error;
      return disposeRuntimeAfterFailure(runtime, error, 'Felan runtime startup cleanup failed');
    }
  }

  async #runPrompt(
    active: ActiveAcpSession,
    params: PromptRequest,
    prompt: PreparedAcpPrompt,
    turn: number,
  ): Promise<PromptResponse> {
    const updates = new AcpPromptUpdateStream({
      sessionId: params.sessionId,
      cwd: active.runtime.cwd,
      turn,
      client: active.client,
      isActive: () => !active.closed && this.#sessions.get(params.sessionId) === active,
      toolCallIds: active.toolCallIds,
    });
    const unsubscribe = active.runtime.session.subscribe((event) => updates.handle(event));
    updates.emitPrompt(prompt.blocks);
    let promptError: unknown;
    let postPreflightAbort: Promise<void> | undefined;
    try {
      await active.runtime.session.prompt(prompt.text, {
        expandPromptTemplates: false,
        source: 'rpc',
        preflightResult: (accepted) => {
          if (!accepted || (!active.cancelRequested && !active.closed)) return;
          postPreflightAbort ??= Promise.resolve().then(() => active.runtime.session.abort());
        },
      });
    } catch (error) {
      promptError = error;
    } finally {
      unsubscribe();
    }
    if (postPreflightAbort !== undefined) {
      try {
        await postPreflightAbort;
      } catch (error) {
        promptError ??= error;
      }
    }
    const cancelled = active.cancelRequested || active.closed;
    updates.finish(cancelled);
    try {
      await updates.flush();
    } catch (error) {
      if (!active.cancelRequested && !active.closed) throw toAcpPromptError(error);
    }
    if (active.cancelRequested || active.closed) return { stopReason: 'cancelled' };
    if (promptError !== undefined) throw toAcpPromptError(promptError);
    return { stopReason: stopReason(active.runtime.session, false) };
  }

  #require(sessionId: string): ActiveAcpSession {
    if (this.#loadingSessions.has(sessionId)) {
      throw RequestError.invalidRequest({ sessionId }, 'Session is still loading');
    }
    const active = this.#sessions.get(sessionId);
    if (!active || active.closed) throw RequestError.resourceNotFound(sessionId);
    return active;
  }

  #assertOpen(): void {
    if (this.#disposed) throw RequestError.internalError(undefined, 'ACP server is closed');
  }

  async #closeSession(
    sessionId: string,
    active: ActiveAcpSession,
  ): Promise<Record<string, never>> {
    await closeActiveSession(active);
    this.#closingSessionIds.delete(sessionId);
    return {};
  }

  #trackLifecycle<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.then(
      () => {},
      (error: unknown) => {
        if (error instanceof AcpRuntimeCleanupError) this.#cleanupFailures.add(error);
      },
    );
    this.#pendingLifecycle.add(settled);
    void settled.then(() => this.#pendingLifecycle.delete(settled));
    return operation;
  }
}

async function requireConfiguredAuthentication(modelRuntime: ModelRuntime): Promise<void> {
  try {
    const providers = modelRuntime.getProviders();
    if (providers.some(({ id }) => modelRuntime.hasConfiguredAuth(id))) return;
    const signal = AbortSignal.timeout(AUTHENTICATION_REFRESH_TIMEOUT_MS);
    await modelRuntime.refresh({
      allowNetwork: false,
      signal,
    });
    if (modelRuntime.getProviders().some(({ id }) => modelRuntime.hasConfiguredAuth(id))) return;
    throw RequestError.authRequired(
      undefined,
      'Configure a model provider before creating a session',
    );
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw RequestError.internalError(undefined, sanitizeAcpErrorMessage(error));
  }
}

async function validateSessionRequest(
  params: Pick<NewSessionRequest, 'cwd' | 'additionalDirectories'>,
): Promise<{
  readonly cwd: string;
}> {
  if (!isAbsolute(params.cwd)) {
    throw RequestError.invalidParams({ cwd: params.cwd }, 'cwd must be an absolute path');
  }
  const cwd = resolve(params.cwd);
  let metadata;
  try {
    metadata = await stat(cwd);
  } catch {
    throw RequestError.resourceNotFound(cwd);
  }
  if (!metadata.isDirectory()) {
    throw RequestError.invalidParams({ cwd }, 'cwd must be a directory');
  }
  if ((params.additionalDirectories?.length ?? 0) > 0) {
    throw RequestError.invalidParams(
      { additionalDirectories: params.additionalDirectories },
      'Additional directories are not supported',
    );
  }
  return { cwd };
}

async function openPersistedSession(
  sessionId: string,
  cwd: string,
  agentDir: string,
): Promise<SessionManager | undefined> {
  const settings = createLocalSettingsManager(cwd, agentDir);
  const sessionDir = settings.getSessionDir() ?? join(agentDir, 'sessions');
  const sessions = await SessionManager.list(cwd, sessionDir);
  const match = sessions.find(({ id }) => id === sessionId);
  return match ? SessionManager.open(match.path, sessionDir) : undefined;
}

function closeActiveSession(active: ActiveAcpSession): Promise<void> {
  active.closePromise ??= performCloseActiveSession(active);
  return active.closePromise;
}

async function performCloseActiveSession(active: ActiveAcpSession): Promise<void> {
  active.closed = true;
  active.cancelRequested = true;
  active.interactions.close();
  const failures: unknown[] = [];
  try {
    await active.runtime.session.abort();
  } catch (error) {
    failures.push(error);
  }
  if (active.activePrompt) {
    await active.activePrompt.catch(() => {});
  }
  try {
    await active.runtime.dispose();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AcpRuntimeCleanupError(failures, 'Failed to clean up an ACP session');
  }
}

function stopReason(session: AgentSession, cancelled: boolean): PromptResponse['stopReason'] {
  if (cancelled) return 'cancelled';
  const assistant = [...session.messages].reverse().find(({ role }) => role === 'assistant');
  if (!assistant || assistant.role !== 'assistant') return 'end_turn';
  if (assistant.stopReason === 'aborted') return 'cancelled';
  if (assistant.stopReason === 'length') return 'max_tokens';
  if (assistant.rawStopReason?.toLowerCase().includes('refusal')) return 'refusal';
  if (assistant.stopReason === 'error') {
    throw RequestError.internalError(
      undefined,
      sanitizeAcpErrorMessage(assistant.errorMessage ?? 'Model request failed'),
    );
  }
  return 'end_turn';
}

async function disposeRuntimeAfterFailure(
  runtime: LocalFelanRuntime,
  error: unknown,
  message: string,
): Promise<never> {
  try {
    await runtime.dispose();
  } catch (cleanupError) {
    throw new AcpRuntimeCleanupError([error, cleanupError], message);
  }
  throw error;
}

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
