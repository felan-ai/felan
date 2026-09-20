import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Type } from 'typebox';
import {
  createAgentCoreSession,
  defineTool,
  HostAgentRuntime,
  selectModelForTier,
  SessionManager,
  SettingsManager,
  type AgentRuntime,
  type AgentRuntimeFileReadOptions,
  type AgentRuntimeFileWriteOptions,
  type AgentRuntimeStorage,
  type AgentRuntimeStorageScope,
  type AgentSession,
  type CreateAgentCoreSessionOptions,
  type ExecOptions,
  type ExecResult,
  type Api,
  type Model,
  type ModelRuntime,
} from '@felan-ai/agent-core';
import {
  createMemoryInputManifest,
  createMemoryDreamerInstructions,
  materializeMemoryInputDelta,
  isSafeMemoryPath,
  type MemoryArtifact,
  type MemoryInputManifest,
  type MemoryInputSession,
  type MemorySnapshot,
  type SessionCheckpoint,
} from '@felan-ai/ext-memory';
import { LocalMemoryRun, memoryRunUsage, sanitizeMemoryDiagnostic } from './run.js';

export interface LocalMemoryDreamInput {
  readonly stagingDirectory: string;
  readonly memoryDirectory: string;
  readonly inputDirectory: string;
  readonly baseSnapshot: MemorySnapshot;
  readonly manifest: MemoryInputManifest;
  readonly modelRuntime: ModelRuntime;
  readonly selectedModel?: Model<Api>;
  readonly scopedModels?: readonly Model<Api>[];
  readonly signal: AbortSignal;
  readonly sessionDirectory?: string;
  readonly run?: LocalMemoryRun;
}

export type LocalMemoryDreamRunner = (input: LocalMemoryDreamInput) => Promise<MemoryArtifact | void>;

export type LocalMemoryDreamSession = Pick<
  AgentSession,
  | 'abort'
  | 'bindExtensions'
  | 'dispose'
  | 'getActiveToolNames'
  | 'messages'
  | 'prompt'
  | 'setActiveToolsByName'
> & Partial<Pick<AgentSession, 'thinkingLevel'>>;

export type LocalMemoryDreamSessionFactory = (
  options: CreateAgentCoreSessionOptions,
) => Promise<{ readonly session: LocalMemoryDreamSession }>;

export interface LocalMemoryDreamRunnerOptions {
  readonly createSession?: LocalMemoryDreamSessionFactory;
  readonly timeoutMs?: number;
}

const REMOVE_MEMORY_PAGE_TOOL_NAME = 'remove_memory_page';
const MEMORY_DREAM_TOOLS = ['read', 'ls', 'edit', 'write', REMOVE_MEMORY_PAGE_TOOL_NAME] as const;
const MEMORY_DREAM_MODEL_TIER = 'low';
const MEMORY_DREAM_THINKING_LEVEL = 'medium';
const DEFAULT_MEMORY_DREAM_TIMEOUT_MS = 60 * 60 * 1_000;
const RemoveMemoryPageParameters = Type.Object({
  path: Type.String({
    minLength: 1,
    maxLength: 4_096,
    description: 'Path to an individual Markdown page under .memory/pages',
  }),
}, { additionalProperties: false });

export class MemoryModelUnavailableError extends Error {
  constructor() {
    super('No authenticated low-tier local memory model is configured');
    this.name = 'MemoryModelUnavailableError';
  }
}

const MEMORY_DREAM_PROMPT = `Process the staged memory input now.

Read .dreaming/input/manifest.json and every transcript listed by that manifest. Inspect the complete existing .memory wiki before changing it. Keep memory sparse: retain only information likely to help a future session that cannot be cheaply recovered from current repository source, documentation, configuration, manifests, tests, or generated files.

Prioritize eligible evidence in this order: (1) direct user-authored durable facts, preferences, decisions, corrections, explicit remember or forget requests, and uncodified rationale; (2) verified non-obvious agent discoveries, incidents, runtime or external-system observations, hidden constraints, and useful unresolved hypotheses. Session records identify provenance: user-role messages are direct user evidence; ordinary tool results, assistant text, subagent output, compaction summaries, and task records are not user-authored evidence. An interactive tool result counts as user evidence only when it explicitly contains the user's answer or feedback.

Do not retain raw tool output, assistant plans or promises, routine task progress, ordinary verification results, transient approvals, repository inventories, implementation details, or repeated paraphrases. Keep a repository-derived conclusion only when it preserves an important rationale, incident, mismatch, or hard-to-rediscover constraint not recorded in the repository. Repetition does not increase importance; merge equivalent claims and keep the strongest provenance. Delete old repository mirrors, transient claims, duplicate claims, overlapping pages, and unnecessary pages during this run, even if they have valid citations. Use remove_memory_page to delete an individual page; do not replace deleted pages with empty files, redirects, or tombstones.

Edit only Markdown files under .memory; do not modify .dreaming/input or access repositories, integrations, credentials, or unrelated files. Do not return a JSON artifact or a patch. The filesystem under .memory is the output. Before finishing, verify required files, links, page reachability, source provenance, and the memory schema. Return only a concise summary after the staged .memory artifact is complete.`;

export interface MaterializeMemoryInputOptions {
  readonly stagingDirectory: string;
  readonly checkpoints: readonly SessionCheckpoint[];
  readonly previousCheckpoints?: Readonly<Record<string, SessionCheckpoint>>;
  readonly baseSnapshot: MemorySnapshot;
  readonly maxInputBytes: number;
  readonly maxTranscriptBytes?: number;
  readonly signal?: AbortSignal;
}

export type MemoryInputMaterializationFailureCode =
  | 'source_unavailable'
  | 'invalid_source'
  | 'checkpoint_changed'
  | 'output_too_large'
  | 'previous_checkpoint_changed'
  | 'source_changed';

export interface MemoryInputMaterializationFailure {
  readonly checkpoint: SessionCheckpoint;
  readonly code: MemoryInputMaterializationFailureCode;
  readonly message: string;
}

export type MaterializeMemoryInputResult = MemoryInputManifest & {
  readonly failures: readonly MemoryInputMaterializationFailure[];
};

export async function materializeMemoryInput({
  stagingDirectory,
  checkpoints,
  previousCheckpoints,
  baseSnapshot,
  maxInputBytes,
  maxTranscriptBytes,
  signal,
}: MaterializeMemoryInputOptions): Promise<MaterializeMemoryInputResult> {
  throwIfAborted(signal);
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0) {
    throw new Error('Memory input byte limit must be a positive safe integer');
  }
  const inputDirectory = join(stagingDirectory, '.dreaming', 'input');
  await mkdir(join(inputDirectory, 'sessions'), { recursive: true, mode: 0o700 });
  const sessions: MemoryInputSession[] = [];
  const failures: MemoryInputMaterializationFailure[] = [];
  let inputBytes = 0;

  for (const [index, checkpoint] of checkpoints.entries()) {
    throwIfAborted(signal);
    const directory = join(inputDirectory, 'sessions', `${String(index).padStart(3, '0')}-${safeSessionDirectoryId(checkpoint.sessionId)}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const transcriptPath = `sessions/${String(index).padStart(3, '0')}-${safeSessionDirectoryId(checkpoint.sessionId)}/transcript.jsonl`;
    const metadataPath = `sessions/${String(index).padStart(3, '0')}-${safeSessionDirectoryId(checkpoint.sessionId)}/metadata.json`;
    try {
      const previousCheckpoint = optionsForSession(checkpoint, previousCheckpoints);
      const evidence = await materializeCheckpointEvidence({
        checkpoint,
        ...(previousCheckpoint === undefined ? {} : { previousCheckpoint }),
        ...(maxTranscriptBytes === undefined ? {} : { maxTranscriptBytes }),
        ...(signal === undefined ? {} : { signal }),
      });
      await writeFile(join(inputDirectory, transcriptPath), evidence.text, { encoding: 'utf8', mode: 0o400 });
      await writeFile(join(inputDirectory, metadataPath), `${JSON.stringify({
        sessionId: checkpoint.sessionId,
        leafId: checkpoint.leafId,
        transcriptDigest: checkpoint.transcriptDigest,
        sessionFile: checkpoint.sessionFile,
        projection: evidence.projection,
      }, null, 2)}\n`, { encoding: 'utf8', mode: 0o400 });
      sessions.push({
        checkpoint,
        metadataPath,
        transcriptPath,
        materializedDigest: evidence.materializedDigest,
        byteLength: evidence.byteLength,
        redactionCount: evidence.redactionCount,
        projection: evidence.projection,
      });
      inputBytes += evidence.byteLength;
      if (inputBytes >= maxInputBytes) break;
    } catch (error) {
      if (!(error instanceof MemoryInputMaterializationError)) throw error;
      failures.push({ checkpoint, code: error.code, message: error.message });
    }
  }

  const manifest = createMemoryInputManifest({
    baseMemoryFingerprint: baseSnapshot.fingerprint,
    sessions,
  });
  await writeFile(join(inputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o400,
  });
  return { ...manifest, failures };
}

function optionsForSession(
  checkpoint: SessionCheckpoint,
  previousCheckpoints: Readonly<Record<string, SessionCheckpoint>> | undefined,
): SessionCheckpoint | undefined {
  return previousCheckpoints?.[checkpoint.sessionId];
}

export function createDefaultLocalMemoryDreamRunner(
  options: LocalMemoryDreamRunnerOptions = {},
): LocalMemoryDreamRunner {
  return async (input) => {
    throwIfAborted(input.signal);
    const run = input.run ?? (input.sessionDirectory === undefined ? undefined : await LocalMemoryRun.create({
      projectDirectory: join(input.stagingDirectory, '.memory-runs'),
      sessionDirectory: input.sessionDirectory,
      projectKey: sha256(input.stagingDirectory),
      projectRoot: input.stagingDirectory,
      checkpoints: input.manifest.sessions.map(({ checkpoint }) => checkpoint),
      baseFingerprint: input.baseSnapshot.fingerprint,
    }));
    const sessionManager = run?.sessionManager ?? SessionManager.inMemory(input.stagingDirectory);
    if (run) sanitizePersistedDreamErrors(sessionManager);
    let session: LocalMemoryDreamSession | undefined;
    try {
      const runtimeDirectory = join(input.stagingDirectory, '.pi-memory-runtime');
      await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
      throwIfAborted(input.signal);
      await run?.record({ phase: 'model' });
      const model = selectMemoryDreamModel(input.modelRuntime, input.selectedModel, input.scopedModels);
      if (!model) throw new MemoryModelUnavailableError();
      await run?.model(model);
      const settingsManager = SettingsManager.inMemory({
        packages: [], extensions: [], skills: [], prompts: [], themes: [], retry: { enabled: false },
      });
      const createSession = options.createSession ?? (async (sessionOptions) => createAgentCoreSession(sessionOptions));
      const runtime = createMemoryDreamRuntime(input.stagingDirectory, runtimeDirectory);
      const created = await createSession({
        runtime,
        agentDir: runtimeDirectory,
        extensionPackages: [],
        importExtension: async (packageName) => {
          throw new Error(`Unexpected memory dream extension: ${packageName}`);
        },
        modelRuntime: input.modelRuntime,
        model,
        thinkingLevel: MEMORY_DREAM_THINKING_LEVEL,
        settingsManager,
        sessionManager,
        customTools: [createRemoveMemoryPageTool(runtime)],
        appendSystemPrompt: [createMemoryDreamerInstructions({
          memoryPath: '.memory', inputPath: '.dreaming/input', label: 'project',
        })],
      });
      const activeSession = created.session;
      session = activeSession;
      await run?.model(model, activeSession.thinkingLevel);
      let cancellation: Promise<void> | undefined;
      let timedOut = false;
      const cancel = (): Promise<void> => {
        cancellation ??= activeSession.abort();
        return cancellation;
      };
      await activeSession.bindExtensions({ mode: 'print' });
      activeSession.setActiveToolsByName([...MEMORY_DREAM_TOOLS]);
      if (!sameToolNames(activeSession.getActiveToolNames(), MEMORY_DREAM_TOOLS)) {
        throw new Error('Memory dream session could not restrict its tools');
      }
      throwIfAborted(input.signal);
      const abort = (): void => { void cancel().catch(() => {}); };
      const timeout = setTimeout(() => {
        timedOut = true;
        void cancel().catch(() => {});
      }, options.timeoutMs ?? DEFAULT_MEMORY_DREAM_TIMEOUT_MS);
      timeout.unref?.();
      input.signal.addEventListener('abort', abort, { once: true });
      try {
        throwIfAborted(input.signal);
        await activeSession.prompt(MEMORY_DREAM_PROMPT);
        await cancellation;
        throwIfAborted(input.signal);
        if (timedOut) throw new Error('Memory dream exceeded its runtime limit');
        const assistant = [...activeSession.messages].reverse().find((message) => message.role === 'assistant');
        if (!assistant) throw new Error('Memory dream completed without an assistant response');
        if (assistant.stopReason === 'error') throw new Error(assistant.errorMessage || 'Local memory model request failed');
        if (assistant.stopReason === 'aborted') throw new Error('Memory model request was interrupted');
        if (run) {
          const usage = memoryRunUsage(sessionManager.getEntries());
          await run.record({ status: 'worker_completed', ...(usage === undefined ? {} : { usage }) });
          if (!input.run) await run.finish('completed');
        }
      } catch (error) {
        if (input.signal.aborted) throw new Error('Memory processing was cancelled');
        if (timedOut) throw new Error('Memory dream exceeded its runtime limit');
        throw error;
      } finally {
        input.signal.removeEventListener('abort', abort);
        clearTimeout(timeout);
        await cancellation?.catch(() => {});
      }
    } catch (error) {
      if (run) {
        const usage = memoryRunUsage(sessionManager.getEntries());
        if (usage) await run.record({ usage });
        if (!input.run) await run.finish(input.signal.aborted ? 'cancelled' : 'failed', error);
      }
      throw error;
    } finally {
      session?.dispose();
    }
  };
}

function safeRetainedDreamMessage(message: Parameters<SessionManager['appendMessage']>[0]): Parameters<SessionManager['appendMessage']>[0] {
  return message.role === 'assistant' && message.errorMessage
    ? { ...message, errorMessage: sanitizeMemoryDiagnostic(message.errorMessage) }
    : message;
}

function sanitizePersistedDreamErrors(sessionManager: SessionManager): void {
  const appendMessage = sessionManager.appendMessage.bind(sessionManager);
  sessionManager.appendMessage = (message) => appendMessage(safeRetainedDreamMessage(message));
}

function selectMemoryDreamModel(
  modelRuntime: ModelRuntime,
  selectedModel: Model<Api> | undefined,
  scopedModels: readonly Model<Api>[] | undefined,
): Model<Api> | undefined {
  const candidates = modelRuntime.getAvailableSnapshot().filter((model) => (
    model.input.includes('text') && (scopedModels === undefined || scopedModels.some((scoped) => (
      scoped.provider === model.provider && scoped.id === model.id
    )))
  ));
  return selectModelForTier(MEMORY_DREAM_MODEL_TIER, candidates, {
    ...(selectedModel === undefined ? {} : { preferredModel: selectedModel }),
  })?.model;
}

interface MaterializeCheckpointEvidenceOptions {
  readonly checkpoint: SessionCheckpoint;
  readonly previousCheckpoint?: SessionCheckpoint;
  readonly maxTranscriptBytes?: number;
  readonly signal?: AbortSignal;
}

interface MaterializedCheckpointEvidence {
  readonly text: string;
  readonly redactionCount: number;
  readonly materializedDigest: string;
  readonly byteLength: number;
  readonly projection: NonNullable<MemoryInputSession['projection']>;
}

class MemoryInputMaterializationError extends Error {
  constructor(
    readonly code: MemoryInputMaterializationFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'MemoryInputMaterializationError';
  }
}

async function materializeCheckpointEvidence({
  checkpoint,
  previousCheckpoint,
  maxTranscriptBytes,
  signal,
}: MaterializeCheckpointEvidenceOptions): Promise<MaterializedCheckpointEvidence> {
  throwIfAborted(signal);
  let sourceBytes: number;
  try {
    const sourceStats = await stat(checkpoint.sessionFile);
    if (!sourceStats.isFile()) throw new Error('not a file');
    sourceBytes = sourceStats.size;
  } catch {
    throw new MemoryInputMaterializationError('source_unavailable', 'Memory checkpoint source is unavailable');
  }

  const result = await materializeMemoryInputDelta({
    lines: () => readSessionFileLinesAsSource(checkpoint.sessionFile, sourceBytes, signal),
    checkpoint,
    ...(previousCheckpoint === undefined ? {} : { previousCheckpoint }),
    ...(maxTranscriptBytes === undefined ? {} : { maxOutputBytes: maxTranscriptBytes }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!result.ok) {
    const code = result.code === 'previous_checkpoint_changed' ? 'previous_checkpoint_changed'
      : result.code === 'checkpoint_changed' ? 'checkpoint_changed'
        : result.code === 'output_too_large' ? 'output_too_large'
          : result.code === 'source_changed' ? 'source_changed' : 'source_unavailable';
    throw new MemoryInputMaterializationError(code, result.message);
  }
  return {
    text: result.text,
    redactionCount: result.redactionCount,
    materializedDigest: result.materializedDigest,
    byteLength: result.byteLength,
    projection: result.projection,
  };
}

async function* readSessionFileLinesAsSource(
  sessionFile: string,
  sourceBytes: number,
  signal: AbortSignal | undefined,
): AsyncIterable<string> {
  if (sourceBytes === 0) return;
  const input = createReadStream(sessionFile, { encoding: 'utf8', start: 0, end: sourceBytes - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      throwIfAborted(signal);
      yield line;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('Memory checkpoint source is unavailable');
  } finally {
    lines.close();
    input.destroy();
  }
}

function createMemoryDreamRuntime(stagingDirectory: string, runtimeDirectory: string): AgentRuntime {
  const base = new HostAgentRuntime(stagingDirectory, {
    sessionStorageRoot: runtimeDirectory,
    agentStorageRoot: runtimeDirectory,
    agentDir: runtimeDirectory,
  });
  return new RestrictedMemoryDreamRuntime(base, resolve(stagingDirectory));
}

function createRemoveMemoryPageTool(runtime: AgentRuntime) {
  return defineTool({
    name: REMOVE_MEMORY_PAGE_TOOL_NAME,
    label: 'Remove Memory Page',
    description: 'Delete one staged Markdown content page under .memory/pages. Root files, area indexes, directories, and files outside staged memory cannot be removed.',
    promptSnippet: 'Delete an obsolete staged memory content page',
    parameters: RemoveMemoryPageParameters,
    async execute(_toolCallId, { path }) {
      const removablePath = removableMemoryPagePath(runtime, path);
      await runtime.readFile(removablePath);
      await runtime.remove(removablePath);
      return {
        content: [{ type: 'text', text: `Removed ${removablePath}` }],
        details: { path: removablePath },
      };
    },
  });
}

function removableMemoryPagePath(runtime: AgentRuntime, path: string): string {
  if (path.includes('\0')) throw new Error('Memory page path contains a NUL byte');
  const relativePath = relative(runtime.cwd, resolve(runtime.cwd, path)).split(sep).join('/');
  const memoryPath = relativePath.startsWith('.memory/')
    ? relativePath.slice('.memory/'.length)
    : undefined;
  if (
    memoryPath === undefined
    || !memoryPath.startsWith('pages/')
    || memoryPath.toLowerCase().endsWith('/index.md')
    || !isSafeMemoryPath(memoryPath)
  ) {
    throw new Error('remove_memory_page only removes individual Markdown content pages under .memory/pages');
  }
  return relativePath;
}

class RestrictedMemoryDreamRuntime implements AgentRuntime {
  readonly kind = 'host' as const;
  readonly cwd: string;

  constructor(
    private readonly base: HostAgentRuntime,
    cwd: string,
  ) {
    this.cwd = cwd;
  }

  get logger() {
    return this.base.logger;
  }

  storage(scope?: AgentRuntimeStorageScope): AgentRuntimeStorage {
    return this.base.storage(scope);
  }

  async exec(_command: string, _args: readonly string[], _options?: ExecOptions): Promise<ExecResult> {
    throw new Error('Memory dream runtime does not permit process execution');
  }

  async shell(_command: string, _options?: ExecOptions & { readonly env?: Readonly<Record<string, string>> }): Promise<ExecResult> {
    throw new Error('Memory dream runtime does not permit shell execution');
  }

  async readFile(path: string, options?: AgentRuntimeFileReadOptions): Promise<Uint8Array> {
    const absolutePath = this.#allowedPath(path, ['.memory', '.dreaming/input']);
    return this.base.readFile(absolutePath, options);
  }

  async writeFile(
    path: string,
    content: Uint8Array,
    options?: AgentRuntimeFileWriteOptions,
  ): Promise<void> {
    const relativePath = this.#allowedPath(path, ['.memory'], true);
    if (!relativePath.endsWith('.md')) throw new Error('Memory dream output must be Markdown');
    await this.base.writeFile(resolve(this.cwd, relativePath), content, options);
  }

  async listFiles(path: string, options?: { readonly recursive?: boolean }): Promise<string[]> {
    const absolutePath = this.#allowedPath(path, ['.memory', '.dreaming/input']);
    return this.base.listFiles(absolutePath, options);
  }

  async mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    const absolutePath = this.#allowedPath(path, ['.memory'], true);
    await this.base.mkdir(absolutePath, options);
  }

  async remove(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    const absolutePath = this.#allowedPath(path, ['.memory'], true);
    await this.base.remove(absolutePath, options);
  }

  #allowedPath(path: string, roots: readonly string[], allowDirectory = false): string {
    if (path.includes('\0')) throw new Error('Memory dream path contains a NUL byte');
    const absolutePath = resolve(this.cwd, path);
    const relativePath = relative(this.cwd, absolutePath);
    if (
      relativePath.length === 0
      || relativePath === '..'
      || relativePath.startsWith(`..${sep}`)
      || isAbsolute(relativePath)
    ) {
      throw new Error('Memory dream path escapes the staging directory');
    }
    const normalized = relativePath.split(sep).join('/');
    if (!roots.some((root) => normalized === root || normalized.startsWith(`${root}/`))) {
      throw new Error('Memory dream path is outside the staged memory inputs');
    }
    if (!allowDirectory && normalized.endsWith('/')) {
      throw new Error('Memory dream path must identify a file');
    }
    return absolutePath;
  }
}

function sameToolNames(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((name) => actual.includes(name));
}

function safeSessionDirectoryId(sessionId: string): string {
  return sha256(sessionId).slice(0, 16);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Memory processing was cancelled');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
