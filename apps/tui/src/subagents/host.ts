import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import {
  HostAgentRuntime,
  SessionManager,
  createAgentCoreSession,
  type CreateAgentCoreSessionOptions,
  type ExtensionPackageImporter,
  type ModelRuntime,
  type SettingsManager,
  type ExtensionConfigOverride,
  type SavingsReporterProvider,
} from '@felan-ai/agent-core';
import {
  bindSubagentSession,
  type SubagentCompletionNotice,
  type SubagentError,
  type SubagentHost,
  type SubagentHostResult,
  type SubagentParentPort,
  type SubagentPolicy,
  type SubagentRecord,
  type SubagentSpawnRequest,
  type SubagentStatus,
} from '@felan-ai/ext-subagents';
import type { MemoryHost } from '@felan-ai/ext-memory';
import type { OutputStyle } from '@felan-ai/ext-output-style';
import {
  CURRENT_SESSION_VERSION,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { createLocalExtensionImporter } from '../extensions.js';
import { createLocalCodexStreamFunctionWrapper } from '../codex.js';
import {
  createLocalAgentRuntimeFactoryRequest,
  type LocalAgentRuntimeFactory,
} from '../runtime-factory.js';
import { loadLocalChildSystemPromptAppends } from '../system-prompt.js';
import { discoverLocalSubagents, type LocalSubagentDefinition } from './catalog.js';
import { LocalSubagentStore, type LocalStoredChild } from './store.js';

const EXT_SUBAGENTS = '@felan-ai/ext-subagents';
const MAX_RESULT_BYTES = 256 * 1024;

export interface LocalSubagentSettings {
  readonly concurrency?: number;
  readonly maxDepth?: number;
}

export interface LocalSubagentView extends SubagentRecord {
  readonly model?: string;
  readonly session?: AgentSession;
}

export interface CreateLocalSubagentHostOptions {
  readonly sessionId: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly homeDir?: string;
  readonly modelRuntime: ModelRuntime;
  readonly settingsManager: SettingsManager;
  readonly scopedModels?: CreateAgentCoreSessionOptions['scopedModels'];
  readonly extensionPackages: readonly string[];
  readonly importExtension: ExtensionPackageImporter;
  readonly outputStyle?: OutputStyle;
  readonly skillPaths?: readonly string[];
  readonly runtimeFactory?: LocalAgentRuntimeFactory;
  readonly memoryHostFactory?: (options: {
    readonly cwd: string;
    readonly sessionStorageRoot: string;
  }) => MemoryHost;
  readonly settings?: LocalSubagentSettings;
  readonly extensionConfigOverrides?: readonly ExtensionConfigOverride[];
  readonly savings?: SavingsReporterProvider;
  readonly runChild?: LocalSubagentRunner;
}

export interface LocalSubagentRunInput {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly depth: number;
  readonly subagents: LocalSubagentHost;
  readonly request: SubagentSpawnRequest;
  readonly definition: LocalSubagentDefinition;
  readonly sessionFile?: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly initialMessage: string;
  readonly onReady: (control: LocalSubagentControl) => Promise<void>;
}

export interface LocalSubagentControl {
  steer(message: string): Promise<void>;
  cancel(): Promise<void>;
}

export interface LocalSubagentRunOutcome {
  readonly result?: string;
  readonly error?: SubagentError;
  readonly sessionFile?: string;
  readonly turnLimitReached?: boolean;
}

export type LocalSubagentRunner = (
  input: LocalSubagentRunInput,
) => Promise<LocalSubagentRunOutcome>;

export function createLocalSubagentExtensionImporter(
  options: Pick<CreateLocalSubagentHostOptions, 'modelRuntime' | 'importExtension' | 'outputStyle'>,
  subagents: LocalSubagentHost,
  memoryHost?: MemoryHost,
): ExtensionPackageImporter {
  return createLocalExtensionImporter(
    subagents,
    options.modelRuntime,
    options.importExtension,
    undefined,
    memoryHost === undefined ? undefined : { role: 'reader', host: memoryHost },
    options.outputStyle,
  );
}

interface MutableChild {
  record: SubagentRecord;
  readonly request: SubagentSpawnRequest;
  readonly depth: number;
  session?: AgentSession;
  sessionFile?: string;
  deliveryId?: string;
  completionPending: boolean;
}

interface Job {
  readonly child: MutableChild;
  readonly controller: AbortController;
  readonly initialMessage: string;
  queuedMessages: string[];
  control?: LocalSubagentControl;
  runPromise?: Promise<void>;
  cancelPromise?: Promise<void>;
  terminalStatus?: 'timed_out' | 'cancelled';
  terminalError?: SubagentError;
  slotHeld: boolean;
}

export class LocalSubagentHost implements SubagentHost {
  readonly descriptors;
  readonly policy: SubagentPolicy;
  readonly #manager: LocalSubagentManager;
  readonly #sessionId: string;

  constructor(manager: LocalSubagentManager, sessionId: string) {
    this.#manager = manager;
    this.#sessionId = sessionId;
    this.descriptors = manager.descriptors;
    this.policy = manager.policy;
  }

  static async create(options: CreateLocalSubagentHostOptions): Promise<LocalSubagentHost> {
    const definitions = await discoverLocalSubagents(options.cwd, options.agentDir, options.homeDir);
    const manager = await LocalSubagentManager.create(options, definitions);
    return new LocalSubagentHost(manager, options.sessionId);
  }

  attachParent(port: SubagentParentPort): () => void {
    return this.#manager.attachParent(this.#sessionId, port);
  }

  spawn(request: SubagentSpawnRequest, signal?: AbortSignal) {
    return this.#manager.spawn(this.#sessionId, request, signal);
  }

  list(options: { readonly includeDescendants: boolean }) {
    return this.#manager.list(this.#sessionId, options);
  }

  getResult(agentId: string) {
    return this.#manager.getResult(this.#sessionId, agentId);
  }

  listLocalSubagents(): readonly LocalSubagentView[] {
    return this.#manager.listLocalSubagents(this.#sessionId);
  }

  getLocalSubagent(agentId: string): LocalSubagentView | undefined {
    return this.#manager.getLocalSubagent(this.#sessionId, agentId);
  }

  steer(agentId: string, message: string) {
    return this.#manager.steer(this.#sessionId, agentId, message);
  }

  cancel(agentId: string, reason?: string) {
    return this.#manager.cancel(this.#sessionId, agentId, reason);
  }

  subscribe(listener: (records: readonly LocalSubagentView[]) => void): () => void {
    return this.#manager.subscribe(listener);
  }

  async shutdown(): Promise<void> {
    await this.#manager.shutdown();
  }

}

export class LocalSubagentManager {
  readonly definitions: ReadonlyMap<string, LocalSubagentDefinition>;
  readonly descriptors;
  readonly policy: SubagentPolicy;
  readonly #options: CreateLocalSubagentHostOptions;
  readonly #store: LocalSubagentStore;
  readonly #children = new Map<string, MutableChild>();
  readonly #ports = new Map<string, SubagentParentPort>();
  readonly #jobs = new Map<string, Job>();
  readonly #queue: Job[] = [];
  readonly #listeners = new Set<(records: readonly LocalSubagentView[]) => void>();
  readonly #deliveries = new Map<string, Promise<void>>();
  readonly #deliveryAttempts = new Map<string, number>();
  readonly #deliveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #concurrency: number;
  readonly #maxDepth: number;
  #active = 0;
  #closed = false;
  #save = Promise.resolve();
  #control = Promise.resolve();
  #shutdown?: Promise<void>;

  private constructor(
    options: CreateLocalSubagentHostOptions,
    definitions: readonly LocalSubagentDefinition[],
  ) {
    this.#options = options;
    this.definitions = new Map(definitions.map((definition) => [definition.descriptor.id, definition]));
    this.descriptors = Object.freeze(definitions.map((definition) => definition.descriptor));
    this.#concurrency = boundedInteger(options.settings?.concurrency, 4, 1, 32);
    this.#maxDepth = boundedInteger(options.settings?.maxDepth, 3, 1, 10);
    this.policy = Object.freeze({
      maxPromptBytes: 128 * 1024,
      maxDescriptionBytes: 512,
      maxSteerBytes: 32 * 1024,
    });
    this.#store = new LocalSubagentStore(options.agentDir, options.sessionId);
  }

  static async create(
    options: CreateLocalSubagentHostOptions,
    definitions: readonly LocalSubagentDefinition[],
  ): Promise<LocalSubagentManager> {
    const manager = new LocalSubagentManager(options, definitions);
    const loaded = await manager.#store.load();
    let reconciled = false;
    for (const stored of loaded) {
      const child = fromStored(stored);
      if (child.record.status === 'queued' || child.record.status === 'running') {
        child.record = terminalRecord(child.record, 'cancelled', {
          code: 'host_shutdown',
          message: 'Local subagent was interrupted when the previous Felan process exited',
        });
        child.completionPending = child.deliveryId !== undefined;
        reconciled = true;
      }
      manager.#children.set(child.record.agentId, child);
    }
    if (reconciled) await manager.#persist();
    return manager;
  }

  attachParent(sessionId: string, port: SubagentParentPort): () => void {
    this.#ports.set(sessionId, port);
    const replay = setTimeout(() => {
      this.#deliverPending(sessionId).catch(() => {});
    }, 0);
    replay.unref();
    return () => {
      clearTimeout(replay);
      if (this.#ports.get(sessionId) === port) this.#ports.delete(sessionId);
    };
  }

  async spawn(
    parentSessionId: string,
    request: SubagentSpawnRequest,
    signal?: AbortSignal,
  ): Promise<SubagentHostResult<SubagentRecord>> {
    if (this.#closed) return failure('host_unavailable', 'Local subagent host is closed');
    if (signal?.aborted) return failure('invalid_request', 'Subagent startup was aborted');
    if (
      byteLength(request.prompt) > this.policy.maxPromptBytes
      || byteLength(request.description) > this.policy.maxDescriptionBytes
    ) {
      return failure('invalid_request', 'Subagent prompt or description exceeds local policy');
    }
    if (request.maxTurns !== undefined && (!Number.isInteger(request.maxTurns) || request.maxTurns < 1 || request.maxTurns > 100)) {
      return failure('invalid_request', 'maxTurns must be an integer from 1 to 100');
    }
    if (
      request.timeoutSeconds !== undefined
      && (!Number.isInteger(request.timeoutSeconds) || request.timeoutSeconds < 1 || request.timeoutSeconds > 86_400)
    ) {
      return failure('invalid_request', 'timeoutSeconds must be an integer from 1 to 86400');
    }
    const definition = this.definitions.get(request.type);
    if (!definition) return failure('unknown_agent_type', `Unknown subagent type: ${request.type}`);
    const resolvedModel = this.#resolveModel(request.model);
    if (!resolvedModel.ok) return resolvedModel;
    if (!this.#supportsThinking(resolvedModel.value, request.thinking)) {
      return failure('unsupported_thinking', 'The resolved model does not support the requested thinking level');
    }
    const normalizedRequest = {
      ...request,
      ...(resolvedModel.value === undefined ? {} : { model: resolvedModel.value }),
    };
    const admitted = await this.#serializeControl(async () => {
      if (this.#closed) return failure('host_unavailable', 'Local subagent host is closed');
      if (signal?.aborted) return failure('invalid_request', 'Subagent startup was aborted');
      const context = this.#sessionContext(parentSessionId);
      if (!context) return failure('parent_unavailable', 'Parent subagent is unavailable');
      if (context.depth >= this.#maxDepth) {
        return failure('depth_exceeded', 'Maximum local subagent depth reached');
      }
      if (request.inheritContext && !this.#ports.has(parentSessionId)) {
        return failure('parent_unavailable', 'Parent context is unavailable');
      }
      const parent = context.child;
      const parentJob = this.#jobs.get(parentSessionId);
      if (
        parent
        && (isTerminal(parent.record.status) || parentJob?.terminalStatus !== undefined)
      ) {
        return failure('parent_unavailable', 'Parent subagent is no longer active');
      }
      if (
        parent
        && !this.definitions.get(parent.record.type)?.descriptor.allowNesting
      ) {
        return failure('depth_exceeded', `${parent.record.type} does not allow nested subagents`);
      }
      let initialMessage: string;
      try {
        initialMessage = await this.#initialMessage(parentSessionId, normalizedRequest);
      } catch {
        return failure('parent_unavailable', 'Parent context could not be captured');
      }
      if (this.#closed) return failure('host_unavailable', 'Local subagent host is closed');
      if (signal?.aborted) return failure('invalid_request', 'Subagent startup was aborted');

      const agentId = randomUUID();
      const now = new Date().toISOString();
      const record: SubagentRecord = {
        agentId,
        parentSessionId,
        rootSessionId: context.rootSessionId,
        type: request.type,
        description: request.description,
        status: 'queued',
        createdAt: now,
      };
      const child: MutableChild = {
        record,
        request: normalizedRequest,
        depth: context.depth + 1,
        deliveryId: randomUUID(),
        completionPending: false,
      };
      const job = this.#job(child, initialMessage);
      this.#children.set(agentId, child);
      this.#jobs.set(agentId, job);
      try {
        await this.#persist();
      } catch {
        this.#children.delete(agentId);
        this.#jobs.delete(agentId);
        return failure('host_unavailable', 'Local subagent startup could not be persisted');
      }
      if (signal?.aborted) {
        this.#children.delete(agentId);
        this.#jobs.delete(agentId);
        await this.#persist();
        return failure('invalid_request', 'Subagent startup was aborted');
      }
      this.#emit();
      return success({ child, job });
    });
    if (!admitted.ok) return admitted;
    const { child, job } = admitted.value;
    const queued = cloneRecord(child.record);
    this.#queue.push(job);
    this.#drain();
    return success(queued);
  }

  async list(
    parentSessionId: string,
    options: { readonly includeDescendants: boolean },
  ): Promise<SubagentHostResult<readonly SubagentRecord[]>> {
    return this.#serializeControl(async () => {
      if (!this.#sessionContext(parentSessionId)) return failure('parent_unavailable', 'Parent subagent is unavailable');
      const direct = new Set([parentSessionId]);
      if (options.includeDescendants) {
        let changed = true;
        while (changed) {
          changed = false;
          for (const child of this.#latestChildren()) {
            if (direct.has(child.record.parentSessionId) && !direct.has(child.record.agentId)) {
              direct.add(child.record.agentId);
              changed = true;
            }
          }
        }
      }
      const records = this.#latestChildren()
        .filter((child) => direct.has(child.record.parentSessionId))
        .map((child) => cloneRecord(child.record))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      return success(records);
    });
  }

  async getResult(
    parentSessionId: string,
    agentId: string,
  ): Promise<SubagentHostResult<SubagentRecord>> {
    const authorized = await this.#serializeControl(async () => this.#directChild(parentSessionId, agentId));
    if (!authorized.ok) return authorized;
    return success(await this.#resultRecord(authorized.value));
  }

  listLocalSubagents(parentSessionId: string): readonly LocalSubagentView[] {
    return this.#latestChildren()
      .filter((child) => child.record.parentSessionId === parentSessionId)
      .map(localView)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getLocalSubagent(parentSessionId: string, agentId: string): LocalSubagentView | undefined {
    return this.listLocalSubagents(parentSessionId)
      .find((child) => child.agentId === agentId);
  }

  async steer(
    parentSessionId: string,
    agentId: string,
    message: string,
  ): Promise<SubagentHostResult<SubagentRecord>> {
    const prepared = await this.#serializeControl(async () => {
      if (this.#closed) return failure('host_unavailable', 'Local subagent host is closed');
      const authorized = this.#directChild(parentSessionId, agentId);
      if (!authorized.ok) return authorized;
      const child = authorized.value;
      if (child.record.status === 'queued' || child.record.status === 'running') {
        const steered = await this.#steerActive(child, message);
        return steered.ok ? success({ kind: 'active' as const, child: steered.value }) : steered;
      }
      if (!isContinuable(child)) {
        return failure('not_steerable', 'Only retained completed or recoverable subagents can be continued');
      }

      return success({
        kind: 'completed' as const,
        child,
        sessionFile: child.sessionFile,
        deliveryId: child.completionPending ? child.deliveryId : undefined,
      });
    });
    if (!prepared.ok) return prepared;
    if (prepared.value.kind === 'active') return success(cloneRecord(prepared.value.child.record));
    const completion = prepared.value;
    const sessionFile = completion.sessionFile;
    if (!sessionFile) return failure('not_steerable', 'The retained subagent session is unavailable');

    try {
      await preflightSessionFile(sessionFile, agentId);
    } catch {
      return failure('not_steerable', 'The retained subagent session is unavailable');
    }
    const continued = await this.#serializeControl(async () => {
      if (this.#closed) return failure('host_unavailable', 'Local subagent host is closed');
      const authorized = this.#directChild(parentSessionId, agentId);
      if (!authorized.ok) return authorized;
      const child = authorized.value;
      if (child.sessionFile !== sessionFile) {
        return failure('not_steerable', 'The retained subagent session changed before continuation');
      }
      if (child.record.status === 'queued' || child.record.status === 'running') {
        const steered = await this.#steerActive(child, message);
        return steered.ok ? success({ child: steered.value, job: undefined }) : steered;
      }
      if (!isContinuable(child)) {
        return failure('not_steerable', 'The retained subagent session changed before continuation');
      }
      const previousRecord = child.record;
      const previousDeliveryId = child.deliveryId;
      const previousCompletionPending = child.completionPending;
      child.record = {
        agentId: child.record.agentId,
        parentSessionId: child.record.parentSessionId,
        rootSessionId: child.record.rootSessionId,
        type: child.record.type,
        description: child.record.description,
        status: 'queued',
        createdAt: child.record.createdAt,
      };
      child.deliveryId = randomUUID();
      child.completionPending = false;
      if (previousDeliveryId !== undefined) {
        this.#deliveryAttempts.delete(previousDeliveryId);
        const timer = this.#deliveryTimers.get(previousDeliveryId);
        if (timer !== undefined) clearTimeout(timer);
        this.#deliveryTimers.delete(previousDeliveryId);
      }
      const job = this.#job(child, message);
      this.#jobs.set(agentId, job);
      try {
        await this.#persist();
      } catch {
        this.#jobs.delete(agentId);
        child.record = previousRecord;
        child.completionPending = previousCompletionPending;
        if (previousDeliveryId === undefined) delete child.deliveryId;
        else child.deliveryId = previousDeliveryId;
        return failure('host_unavailable', 'Subagent continuation could not be persisted');
      }
      this.#queue.push(job);
      this.#emit();
      return success({ child, job });
    });
    if (!continued.ok) return continued;
    if (continued.value.job) this.#drain();
    return success(cloneRecord(continued.value.child.record));
  }

  async cancel(
    parentSessionId: string,
    agentId: string,
    reason = 'Cancelled by parent',
  ): Promise<SubagentHostResult<SubagentRecord>> {
    const authorized = this.#directChild(parentSessionId, agentId);
    if (!authorized.ok) return authorized;
    await this.#cancelTree(agentId, reason, 'cancelled', 'cancelled_by_parent');
    return success(cloneRecord(this.#latest(agentId)!.record));
  }

  subscribe(listener: (records: readonly LocalSubagentView[]) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#latestChildren().map(localView));
    return () => this.#listeners.delete(listener);
  }

  async shutdown(): Promise<void> {
    this.#shutdown ??= this.#performShutdown();
    await this.#shutdown;
  }

  async #performShutdown(): Promise<void> {
    this.#closed = true;
    for (const timer of this.#deliveryTimers.values()) clearTimeout(timer);
    this.#deliveryTimers.clear();
    await this.#serializeControl(async () => {});
    for (const child of this.#latestChildren()) {
      if (!isTerminal(child.record.status)) await this.#cancelTree(child.record.agentId, 'Local host exited');
    }
    await Promise.allSettled(this.#deliveries.values());
    await this.#save;
  }

  async #steerActive(
    child: MutableChild,
    message: string,
  ): Promise<SubagentHostResult<MutableChild>> {
    const job = this.#jobs.get(child.record.agentId);
    if (!job || job.terminalStatus) {
      return failure('not_steerable', 'Subagent session is unavailable');
    }
    if (job.control) await job.control.steer(message);
    else job.queuedMessages.push(message);
    return success(child);
  }

  #job(child: MutableChild, initialMessage: string): Job {
    return {
      child,
      controller: new AbortController(),
      initialMessage,
      queuedMessages: [],
      slotHeld: false,
    };
  }

  #drain(): void {
    this.#serializeControl(async () => {
      while (!this.#closed && this.#active < this.#concurrency && this.#queue.length > 0) {
        const job = this.#queue.shift()!;
        if (job.child.record.status !== 'queued') continue;
        await this.#beginRun(job);
      }
    }).catch(() => {});
  }

  async #beginRun(job: Job): Promise<void> {
    if (job.runPromise || job.child.record.status !== 'queued') return;
    if (!job.slotHeld) {
      if (this.#active >= this.#concurrency) {
        this.#queue.unshift(job);
        return;
      }
      job.slotHeld = true;
      this.#active += 1;
    }
    job.child.record = {
      ...job.child.record,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    await this.#persist();
    this.#emit();
    job.runPromise = this.#run(job);
  }

  async #run(job: Job): Promise<void> {
    const child = job.child;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let outcome: LocalSubagentRunOutcome | undefined;
    try {
      if (child.request.timeoutSeconds) {
        timeout = setTimeout(() => {
          this.#cancelTree(
            child.record.agentId,
            `Subagent timed out after ${child.request.timeoutSeconds} seconds`,
            'timed_out',
            'timed_out',
          ).catch(() => {});
        }, child.request.timeoutSeconds * 1_000);
        timeout.unref();
      }

      const definition = this.definitions.get(child.record.type)!;
      if (!job.controller.signal.aborted) {
        const queuedAtStart = job.queuedMessages.splice(0);
        const input: LocalSubagentRunInput = {
          sessionId: child.record.agentId,
          rootSessionId: child.record.rootSessionId,
          depth: child.depth,
          subagents: new LocalSubagentHost(this, child.record.agentId),
          request: child.request,
          definition,
          cwd: this.#options.cwd,
          signal: job.controller.signal,
          initialMessage: [job.initialMessage, ...queuedAtStart].join('\n\n'),
          onReady: async (control) => {
            job.control = control;
            if (job.terminalStatus) this.#cancelControl(job);
            await job.cancelPromise;
            if (job.terminalStatus) return;
            const pending = job.queuedMessages.splice(0);
            for (const message of pending) await control.steer(message);
          },
          ...(child.sessionFile === undefined ? {} : { sessionFile: child.sessionFile }),
        };
        outcome = this.#options.runChild
          ? await this.#options.runChild(input)
          : await this.#runAgentCore(input, async (session, sessionFile) => {
            child.session = session;
            child.sessionFile = sessionFile;
            await this.#persist();
            this.#emit();
          });
      }
      await job.cancelPromise;
      outcome ??= {};
    } catch {
      await job.cancelPromise;
      outcome = { error: { code: 'internal_error', message: 'Local subagent failed unexpectedly' } };
    } finally {
      if (timeout) clearTimeout(timeout);
      await this.#serializeControl(async () => {
        if (outcome?.sessionFile) child.sessionFile = outcome.sessionFile;
        if (job.terminalStatus) {
          child.record = terminalRecord(child.record, job.terminalStatus, job.terminalError);
        } else if (outcome?.turnLimitReached) {
          child.record = terminalRecord(child.record, 'cancelled', {
            code: 'turn_limit_reached',
            message: `Subagent reached its ${child.request.maxTurns} turn limit`,
          });
        } else if (outcome?.error) {
          child.record = terminalRecord(child.record, 'failed', outcome.error);
        } else {
          child.record = {
            ...terminalRecord(child.record, 'completed'),
            result: boundResult(outcome?.result ?? ''),
          };
        }
        if (job.slotHeld) {
          job.slotHeld = false;
          this.#active -= 1;
        }
        this.#jobs.delete(child.record.agentId);
        if (child.deliveryId) child.completionPending = true;
        await this.#persist();
        this.#emit();
      });
      if (child.deliveryId) await this.#deliver(child, child.deliveryId);
      this.#drain();
    }
  }

  #requestCancellation(
    job: Job,
    status: 'timed_out' | 'cancelled',
    error: SubagentError,
  ): void {
    if (job.terminalStatus || isTerminal(job.child.record.status)) return;
    job.terminalStatus = status;
    job.terminalError = error;
    job.controller.abort();
    this.#cancelControl(job);
  }

  #cancelControl(job: Job): void {
    if (!job.control || job.cancelPromise) return;
    job.cancelPromise = job.control.cancel().catch(() => {});
  }

  async #runAgentCore(
    input: LocalSubagentRunInput,
    onSession: (session: AgentSession, sessionFile: string) => Promise<void>,
  ): Promise<LocalSubagentRunOutcome> {
    const runtimeRequest = createLocalAgentRuntimeFactoryRequest(
      input.cwd,
      this.#options.agentDir,
      input.rootSessionId,
    );
    const memoryHost = this.#options.memoryHostFactory?.({
      cwd: input.cwd,
      sessionStorageRoot: runtimeRequest.sessionStorageRoot,
    });
    await Promise.all([
      mkdir(this.#store.sessionDirectory(), { recursive: true }),
      mkdir(runtimeRequest.sessionStorageRoot, { recursive: true }),
      mkdir(runtimeRequest.agentStorageRoot, { recursive: true }),
    ]);
    if (input.signal.aborted) return {};
    const sessionManager = input.sessionFile
      ? SessionManager.open(input.sessionFile, this.#store.sessionDirectory(), input.cwd)
      : SessionManager.create(input.cwd, this.#store.sessionDirectory(), { id: input.sessionId });
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) {
      return {
        error: { code: 'internal_error', message: 'Subagent session file could not be created' },
      };
    }
    const model = input.request.model ? this.#exactModel(input.request.model) : undefined;
    if (input.request.model && !model) {
      return { error: { code: 'unsupported_model', message: 'The requested model is unavailable' } };
    }
    const canNest = input.definition.descriptor.allowNesting && input.depth < this.#maxDepth;
    const extensionPackages = canNest
      ? this.#options.extensionPackages
      : this.#options.extensionPackages.filter((packageName) => packageName !== EXT_SUBAGENTS);
    if (input.signal.aborted) return {};
    const appendSystemPrompt = await loadLocalChildSystemPromptAppends(
      this.#options.agentDir,
      input.definition.prompt,
    );
    const runtime = this.#options.runtimeFactory?.(runtimeRequest)
      ?? new HostAgentRuntime(input.cwd, runtimeRequest);
    const wrapStreamFunction = await createLocalCodexStreamFunctionWrapper(
      extensionPackages,
      runtime,
      this.#options.agentDir,
    );
    const created = await createAgentCoreSession({
      runtime,
      ...(wrapStreamFunction === undefined ? {} : { wrapStreamFunction }),
      extensionPackages,
      importExtension: createLocalSubagentExtensionImporter(
        this.#options,
        input.subagents,
        memoryHost,
      ),
      modelRuntime: this.#options.modelRuntime,
      settingsManager: this.#options.settingsManager,
      sessionManager,
      appendSystemPrompt,
      ...(this.#options.skillPaths === undefined ? {} : { skillPaths: this.#options.skillPaths }),
      ...(model === undefined ? {} : { model }),
      ...(input.request.thinking === undefined ? {} : { thinkingLevel: input.request.thinking }),
      ...(this.#options.scopedModels === undefined
        ? {}
        : { scopedModels: this.#options.scopedModels }),
      ...(this.#options.extensionConfigOverrides === undefined
        ? {}
        : { extensionConfigOverrides: this.#options.extensionConfigOverrides }),
      ...(this.#options.savings === undefined ? {} : { savings: this.#options.savings }),
    });
    try {
      await onSession(created.session, sessionFile);
      bindSubagentSession({ host: input.subagents, session: created.session });
      if (input.signal.aborted) return sessionFileOutcome(created.session.sessionFile);
      await created.session.bindExtensions({ mode: 'print' });
      if (input.definition.toolProfile === 'inspection') {
        created.session.setActiveToolsByName(inspectionToolNames(created.session.getActiveToolNames()));
      }
      if (input.signal.aborted) return sessionFileOutcome(created.session.sessionFile);

      let turns = 0;
      let turnLimitReached = false;
      let cancellation: Promise<void> | undefined;
      const cancel = () => {
        cancellation ??= created.session.abort();
        return cancellation;
      };
      const unsubscribe = created.session.subscribe((event) => {
        if (event.type !== 'turn_end') return;
        turns += 1;
        if (
          input.request.maxTurns
          && turns >= input.request.maxTurns
          && event.message.role === 'assistant'
          && event.message.stopReason === 'toolUse'
        ) {
          turnLimitReached = true;
          cancel().catch(() => {});
        }
      });
      const abort = () => {
        cancel().catch(() => {});
      };
      input.signal.addEventListener('abort', abort, { once: true });
      try {
        if (input.signal.aborted) {
          await cancel();
          return sessionFileOutcome(created.session.sessionFile);
        }
        await input.onReady({
          steer: (message) => created.session.steer(message),
          cancel,
        });
        if (input.signal.aborted) {
          await cancel();
          return sessionFileOutcome(created.session.sessionFile);
        }
        await created.session.prompt(input.initialMessage);
        await cancellation;
        const assistant = [...created.session.messages].reverse().find((message) => message.role === 'assistant');
        if (turnLimitReached) {
          return {
            ...sessionFileOutcome(created.session.sessionFile),
            turnLimitReached: true,
          };
        }
        if (!assistant) {
          return {
            error: { code: 'internal_error', message: 'Subagent completed without an assistant response' },
            ...sessionFileOutcome(created.session.sessionFile),
          };
        }
        if (assistant.stopReason !== 'stop') {
          return {
            error: {
              code: assistant.stopReason === 'error' ? 'model_request_failed' : 'internal_error',
              message: assistant.stopReason === 'error'
                ? `Model request failed: ${sanitizeModelError(assistant.errorMessage)}`
                : `Subagent ended without a final response (${assistant.stopReason})`,
            },
            ...sessionFileOutcome(created.session.sessionFile),
          };
        }
        const result = assistant.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n');
        if (!result.trim()) {
          return {
            error: { code: 'internal_error', message: 'Subagent completed without a final result' },
            ...sessionFileOutcome(created.session.sessionFile),
          };
        }
        return {
          result,
          ...sessionFileOutcome(created.session.sessionFile),
          ...(turnLimitReached ? { turnLimitReached: true } : {}),
        };
      } finally {
        input.signal.removeEventListener('abort', abort);
        await cancellation;
        unsubscribe();
      }
    } finally {
      created.session.dispose();
    }
  }

  #resolveModel(
    selector: string | undefined,
  ): SubagentHostResult<string | undefined> {
    if (!selector) return success(undefined);
    if (selector === 'inherit') {
      return failure('unsupported_model', 'Parent model is unavailable');
    }
    const model = this.#exactModel(selector);
    return model && this.#options.modelRuntime.hasConfiguredAuth(model.provider)
      ? success(`${model.provider}/${model.id}`)
      : failure('unsupported_model', 'The requested model is unavailable or unauthenticated');
  }

  #supportsThinking(modelReference: string | undefined, thinking: SubagentSpawnRequest['thinking']): boolean {
    if (thinking === undefined || thinking === 'off') return true;
    if (!modelReference) return false;
    const model = this.#exactModel(modelReference);
    if (!model?.reasoning) return false;
    const mapped = model.thinkingLevelMap?.[thinking];
    return thinking === 'xhigh' || thinking === 'max'
      ? mapped !== undefined && mapped !== null
      : mapped !== null;
  }

  #exactModel(reference: string): ReturnType<ModelRuntime['getModel']> {
    const separator = reference.indexOf('/');
    if (separator <= 0 || separator === reference.length - 1) return undefined;
    return this.#options.modelRuntime.getModel(reference.slice(0, separator), reference.slice(separator + 1));
  }

  async #initialMessage(parentSessionId: string, request: SubagentSpawnRequest): Promise<string> {
    if (!request.inheritContext) return request.prompt;
    const snapshot = await this.#ports.get(parentSessionId)?.snapshotContext({ maxBytes: 64 * 1024 });
    if (!snapshot || snapshot.length === 0) return request.prompt;
    return `${request.prompt}\n\nParent context:\n${snapshot.map((entry) => `${entry.role}: ${entry.text}`).join('\n\n')}`;
  }

  #directChild(
    parentSessionId: string,
    agentId: string,
  ): SubagentHostResult<MutableChild> {
    const child = this.#children.get(agentId);
    if (!child) return failure('not_found', `Subagent not found: ${agentId}`);
    if (child.record.parentSessionId !== parentSessionId) {
      return failure('not_child', 'The subagent is not a direct child of this session');
    }
    return success(child);
  }

  #sessionContext(sessionId: string): {
    rootSessionId: string;
    depth: number;
    child?: MutableChild;
  } | undefined {
    if (sessionId === this.#options.sessionId) {
      return { rootSessionId: sessionId, depth: 0 };
    }
    const child = this.#children.get(sessionId);
    if (!child) return undefined;
    return { rootSessionId: child.record.rootSessionId, depth: child.depth, child };
  }

  async #cancelTree(
    agentId: string,
    reason: string,
    status: 'timed_out' | 'cancelled' = 'cancelled',
    errorCode: SubagentError['code'] = 'host_shutdown',
  ): Promise<void> {
    const cancellation = await this.#serializeControl(async () => {
      const descendants = this.#latestChildren()
        .filter((entry) => entry.record.parentSessionId === agentId && !isTerminal(entry.record.status))
        .map((entry) => entry.record.agentId);
      const child = this.#latest(agentId);
      if (!child || isTerminal(child.record.status)) {
        return { descendants, cleanup: Promise.resolve(), deliveryId: undefined };
      }
      const job = this.#jobs.get(agentId);
      if (child.record.status === 'queued') {
        const queueIndex = job ? this.#queue.indexOf(job) : -1;
        if (queueIndex >= 0) this.#queue.splice(queueIndex, 1);
        job?.controller.abort();
        if (job?.slotHeld) {
          job.slotHeld = false;
          this.#active -= 1;
        }
        child.record = terminalRecord(child.record, status, {
          code: errorCode,
          message: reason,
        });
        if (child.deliveryId) child.completionPending = true;
        this.#jobs.delete(agentId);
        await this.#persist();
        this.#emit();
        return { descendants, cleanup: Promise.resolve(), deliveryId: child.deliveryId };
      }
      if (!job) return { descendants, cleanup: Promise.resolve(), deliveryId: undefined };
      this.#requestCancellation(job, status, {
        code: errorCode,
        message: reason,
      });
      return { descendants, cleanup: job.runPromise ?? Promise.resolve(), deliveryId: undefined };
    });
    await Promise.all(cancellation.descendants.map((childId) => (
      this.#cancelTree(childId, reason, status, errorCode)
    )));
    await cancellation.cleanup;
    if (cancellation.deliveryId) {
      const child = this.#latest(agentId);
      if (child) await this.#deliver(child, cancellation.deliveryId);
      this.#drain();
    }
  }

  async #deliver(child: MutableChild, deliveryId: string): Promise<void> {
    if (!child.completionPending || child.deliveryId !== deliveryId) return;
    const existing = this.#deliveries.get(deliveryId);
    if (existing) return existing;
    const notice = completionNotice(child.record, deliveryId);
    const delivery = (async () => {
      const port = this.#ports.get(child.record.parentSessionId);
      if (!port) return;
      const outcome = await port.deliverCompletion(notice);
      if (outcome === 'delivered') {
        this.#deliveryAttempts.delete(deliveryId);
        const timer = this.#deliveryTimers.get(deliveryId);
        if (timer !== undefined) clearTimeout(timer);
        this.#deliveryTimers.delete(deliveryId);
        await this.#serializeControl(async () => {
          if (child.deliveryId !== deliveryId) return;
          child.completionPending = false;
          await this.#persist();
        });
      } else if (!this.#closed) {
        const attempt = (this.#deliveryAttempts.get(deliveryId) ?? 0) + 1;
        this.#deliveryAttempts.set(deliveryId, attempt);
        const delay = Math.min(5_000, 100 * (2 ** Math.min(attempt - 1, 5)));
        const retry = setTimeout(() => {
          this.#deliveryTimers.delete(deliveryId);
          this.#deliver(child, deliveryId).catch(() => {});
        }, delay);
        retry.unref();
        this.#deliveryTimers.set(deliveryId, retry);
      }
    })();
    this.#deliveries.set(deliveryId, delivery);
    try {
      await delivery;
    } finally {
      if (this.#deliveries.get(deliveryId) === delivery) this.#deliveries.delete(deliveryId);
    }
  }

  async #deliverPending(parentSessionId: string): Promise<void> {
    const children = [...this.#children.values()]
      .filter((child) => child.record.parentSessionId === parentSessionId && child.completionPending);
    for (const child of children) {
      if (child.deliveryId) await this.#deliver(child, child.deliveryId);
    }
  }

  #latest(agentId: string): MutableChild | undefined {
    return this.#children.get(agentId);
  }

  #latestChildren(): MutableChild[] {
    return [...this.#children.values()];
  }

  #emit(): void {
    const records = this.#latestChildren().map(localView);
    for (const listener of this.#listeners) listener(records);
  }

  async #persist(): Promise<void> {
    const snapshot = [...this.#children.values()].map(toStored);
    this.#save = this.#save.catch(() => {}).then(() => this.#store.save(snapshot));
    await this.#save;
  }

  async #serializeControl<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#control;
    let release!: () => void;
    this.#control = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #resultRecord(child: MutableChild): Promise<SubagentRecord> {
    const record = cloneRecord(child.record);
    if (record.status !== 'completed' || !child.sessionFile || !record.completedAt) return record;
    try {
      const result = await finalAssistantText(child.sessionFile, record.completedAt);
      return result === undefined ? record : { ...record, result };
    } catch {
      return record;
    }
  }
}

export function inspectionToolNames(activeToolNames: readonly string[]): string[] {
  const blocked = new Set([
    'bash',
    'edit',
    'write',
    'exec_command',
    'write_stdin',
    'apply_patch',
    'enter_prewalk',
  ]);
  const safe = activeToolNames.filter((name) => !blocked.has(name));
  if (!safe.includes('read')) safe.unshift('read');
  return safe;
}

function completionNotice(record: SubagentRecord, deliveryId: string): SubagentCompletionNotice {
  return {
    deliveryId,
    parentSessionId: record.parentSessionId,
    agentId: record.agentId,
    type: record.type,
    status: record.status as SubagentCompletionNotice['status'],
    ...(record.result === undefined ? {} : { summary: record.result.slice(0, 4_000) }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

function terminalRecord(
  record: SubagentRecord,
  status: Extract<SubagentStatus, 'completed' | 'failed' | 'timed_out' | 'cancelled'>,
  error?: SubagentError,
): SubagentRecord {
  return {
    ...record,
    status,
    completedAt: new Date().toISOString(),
    ...(error === undefined ? {} : { error }),
  };
}

function isTerminal(status: SubagentStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'timed_out' || status === 'cancelled';
}

function isContinuable(child: MutableChild): boolean {
  if (!child.sessionFile) return false;
  if (child.record.status === 'completed') return true;
  if (child.record.status === 'failed' && child.record.error?.code === 'model_request_failed') return true;
  if (child.record.status !== 'cancelled') return false;
  return child.record.error?.code === 'turn_limit_reached'
    || child.record.error?.code === 'host_shutdown';
}

function sanitizeModelError(value: string | undefined): string {
  const normalized = (value ?? 'unknown provider error')
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return 'unknown provider error';
  return normalized.length <= 300 ? normalized : `${normalized.slice(0, 299)}…`;
}

function success<T>(value: T): SubagentHostResult<T> {
  return { ok: true, value };
}

function failure(code: SubagentError['code'], message: string): SubagentHostResult<never> {
  return { ok: false, error: { code, message } };
}

function cloneRecord(record: SubagentRecord): SubagentRecord {
  return structuredClone(record);
}

function localView(child: MutableChild): LocalSubagentView {
  return {
    ...cloneRecord(child.record),
    ...(child.request.model === undefined ? {} : { model: child.request.model }),
    ...(child.session === undefined ? {} : { session: child.session }),
  };
}

function fromStored(stored: LocalStoredChild): MutableChild {
  return structuredClone(stored) as MutableChild;
}

function toStored(child: MutableChild): LocalStoredChild {
  return structuredClone({
    record: child.record,
    request: child.request,
    depth: child.depth,
    ...(child.sessionFile === undefined ? {} : { sessionFile: child.sessionFile }),
    ...(child.deliveryId === undefined ? {} : { deliveryId: child.deliveryId }),
    completionPending: child.completionPending,
  });
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return value === undefined || !Number.isInteger(value)
    ? fallback
    : Math.max(minimum, Math.min(maximum, value));
}

function boundResult(result: string): string {
  const bytes = Buffer.from(result);
  return bytes.byteLength <= MAX_RESULT_BYTES
    ? result
    : `${new TextDecoder().decode(bytes.subarray(0, MAX_RESULT_BYTES))}\n[truncated]`;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value);
}

function sessionFileOutcome(sessionFile: string | undefined): Pick<LocalSubagentRunOutcome, 'sessionFile'> {
  return sessionFile === undefined ? {} : { sessionFile };
}

async function preflightSessionFile(sessionFile: string, expectedSessionId: string): Promise<void> {
  const contents = await readFile(sessionFile, 'utf8');
  let header: unknown;
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    const entry: unknown = JSON.parse(line);
    header ??= entry;
  }
  if (
    typeof header !== 'object'
    || header === null
    || Reflect.get(header, 'type') !== 'session'
    || Reflect.get(header, 'version') !== CURRENT_SESSION_VERSION
    || Reflect.get(header, 'id') !== expectedSessionId
    || typeof Reflect.get(header, 'timestamp') !== 'string'
    || typeof Reflect.get(header, 'cwd') !== 'string'
  ) {
    throw new Error('Retained session file has an invalid header');
  }
}

async function finalAssistantText(sessionFile: string, completedAt: string): Promise<string | undefined> {
  let result: string | undefined;
  for (const line of (await readFile(sessionFile, 'utf8')).split('\n')) {
    if (!line) continue;
    const entry = JSON.parse(line) as {
      type?: string;
      timestamp?: string;
      message?: { role?: string; content?: unknown };
    };
    if (
      entry.type !== 'message'
      || entry.message?.role !== 'assistant'
      || typeof entry.timestamp !== 'string'
      || entry.timestamp > completedAt
      || !Array.isArray(entry.message.content)
    ) continue;
    result = entry.message.content
      .filter((part): part is { type: 'text'; text: string } => (
        typeof part === 'object'
        && part !== null
        && Reflect.get(part, 'type') === 'text'
        && typeof Reflect.get(part, 'text') === 'string'
      ))
      .map((part) => part.text)
      .join('\n');
  }
  return result;
}
