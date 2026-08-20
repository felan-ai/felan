import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  createAgentCoreSession,
  HostAgentRuntime,
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
  createActiveBranchDigester,
  createMemoryInputManifest,
  createMemoryDreamerInstructions,
  isMemoryContextEntry,
  type MemoryArtifact,
  type MemoryInputManifest,
  type MemoryInputSession,
  type MemorySnapshot,
  type SessionCheckpoint,
} from '@felan-ai/ext-memory';

export interface LocalMemoryDreamInput {
  readonly stagingDirectory: string;
  readonly memoryDirectory: string;
  readonly inputDirectory: string;
  readonly baseSnapshot: MemorySnapshot;
  readonly manifest: MemoryInputManifest;
  readonly modelRuntime: ModelRuntime;
  readonly selectedModel?: Model<Api>;
  readonly signal: AbortSignal;
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
>;

export type LocalMemoryDreamSessionFactory = (
  options: CreateAgentCoreSessionOptions,
) => Promise<{ readonly session: LocalMemoryDreamSession }>;

export interface LocalMemoryDreamRunnerOptions {
  readonly createSession?: LocalMemoryDreamSessionFactory;
  readonly timeoutMs?: number;
}

const MEMORY_DREAM_TOOLS = ['read', 'ls', 'edit', 'write'] as const;
const DEFAULT_MEMORY_DREAM_TIMEOUT_MS = 60 * 60 * 1_000;

const MEMORY_DREAM_PROMPT = `Process the staged memory input now.

Read .dreaming/input/manifest.json and every transcript listed by that manifest. Inspect the existing .memory wiki and merge durable facts from only those target sessions into it. Edit the Markdown files under .memory in place; do not modify .dreaming/input or access repositories, integrations, credentials, or unrelated files.

Do not return a JSON artifact or a patch. The filesystem under .memory is the output. Before finishing, verify the required files, links, page reachability, source provenance, and the memory schema. Return only a concise summary after the staged .memory artifact is complete.`;

export interface MaterializeMemoryInputOptions {
  readonly stagingDirectory: string;
  readonly checkpoints: readonly SessionCheckpoint[];
  readonly previousCheckpoints?: Readonly<Record<string, SessionCheckpoint>>;
  readonly baseSnapshot: MemorySnapshot;
  readonly maxTranscriptBytes: number;
  readonly signal?: AbortSignal;
}

export type MemoryInputMaterializationFailureCode =
  | 'source_unavailable'
  | 'invalid_source'
  | 'checkpoint_changed'
  | 'previous_checkpoint_changed';

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
  maxTranscriptBytes,
  signal,
}: MaterializeMemoryInputOptions): Promise<MaterializeMemoryInputResult> {
  throwIfAborted(signal);
  const inputDirectory = join(stagingDirectory, '.dreaming', 'input');
  await mkdir(join(inputDirectory, 'sessions'), { recursive: true, mode: 0o700 });
  const sessions: MemoryInputSession[] = [];
  const failures: MemoryInputMaterializationFailure[] = [];
  const ordered = [...checkpoints].sort((left, right) => left.sessionId.localeCompare(right.sessionId));

  for (const [index, checkpoint] of ordered.entries()) {
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
        maxTranscriptBytes,
        ...(signal === undefined ? {} : { signal }),
      });
      await writeFile(join(inputDirectory, transcriptPath), evidence.text, { encoding: 'utf8', mode: 0o400 });
      await writeFile(join(inputDirectory, metadataPath), `${JSON.stringify({
        sessionId: checkpoint.sessionId,
        leafId: checkpoint.leafId,
        transcriptDigest: checkpoint.transcriptDigest,
        sessionFile: checkpoint.sessionFile,
        truncated: evidence.truncated,
      }, null, 2)}\n`, { encoding: 'utf8', mode: 0o400 });
      sessions.push({
        checkpoint,
        metadataPath,
        transcriptPath,
        materializedDigest: sha256(evidence.text),
        byteLength: Buffer.byteLength(evidence.text, 'utf8'),
        redactionCount: evidence.redactionCount,
      });
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
    const model = selectMemoryDreamModel(input.modelRuntime, input.selectedModel);
    if (!model) throw new Error('No authenticated local memory model is configured');

    const runtimeDirectory = join(input.stagingDirectory, '.pi-memory-runtime');
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    throwIfAborted(input.signal);
    const runtime = createMemoryDreamRuntime(input.stagingDirectory, runtimeDirectory);
    const sessionManager = SessionManager.inMemory(input.stagingDirectory);
    const settingsManager = SettingsManager.inMemory({
      packages: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
      retry: { enabled: false },
    });
    const createSession = options.createSession
      ?? (async (sessionOptions) => createAgentCoreSession(sessionOptions));
    const created = await createSession({
      runtime,
      agentDir: runtimeDirectory,
      extensionPackages: [],
      importExtension: async (packageName) => {
        throw new Error(`Unexpected memory dream extension: ${packageName}`);
      },
      modelRuntime: input.modelRuntime,
      model,
      settingsManager,
      sessionManager,
      appendSystemPrompt: [createMemoryDreamerInstructions({
        memoryPath: '.memory',
        inputPath: '.dreaming/input',
        label: 'project',
      })],
    });
    const session = created.session;
    let cancellation: Promise<void> | undefined;
    let timedOut = false;
    const cancel = (): Promise<void> => {
      cancellation ??= session.abort();
      return cancellation;
    };
    const timeoutMs = options.timeoutMs ?? DEFAULT_MEMORY_DREAM_TIMEOUT_MS;

    try {
      await session.bindExtensions({ mode: 'print' });
      session.setActiveToolsByName([...MEMORY_DREAM_TOOLS]);
      if (!sameToolNames(session.getActiveToolNames(), MEMORY_DREAM_TOOLS)) {
        throw new Error('Memory dream session could not restrict its tools');
      }
      throwIfAborted(input.signal);

      const abort = (): void => {
        void cancel().catch(() => {});
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        void cancel().catch(() => {});
      }, timeoutMs);
      timeout.unref?.();
      input.signal.addEventListener('abort', abort, { once: true });
      try {
        await session.prompt(MEMORY_DREAM_PROMPT);
        await cancellation;
        throwIfAborted(input.signal);
        if (timedOut) throw new Error('Memory dream exceeded its runtime limit');
        const assistant = [...session.messages].reverse().find((message) => message.role === 'assistant');
        if (!assistant) throw new Error('Memory dream completed without an assistant response');
        if (assistant.stopReason === 'error') throw new Error('Local memory model request failed');
      } catch (error) {
        if (input.signal.aborted) throw new Error('Memory processing was cancelled');
        if (timedOut) throw new Error('Memory dream exceeded its runtime limit');
        throw error;
      } finally {
        input.signal.removeEventListener('abort', abort);
        clearTimeout(timeout);
        await cancellation?.catch(() => {});
      }
    } finally {
      session.dispose();
    }
  };
}

function selectMemoryDreamModel(
  modelRuntime: ModelRuntime,
  selectedModel: Model<Api> | undefined,
): Model<Api> | undefined {
  if (selectedModel && modelRuntime.hasConfiguredAuth(selectedModel.provider)) {
    return selectedModel;
  }
  return modelRuntime.getAvailableSnapshot()[0];
}

interface MaterializeCheckpointEvidenceOptions {
  readonly checkpoint: SessionCheckpoint;
  readonly previousCheckpoint?: SessionCheckpoint;
  readonly maxTranscriptBytes: number;
  readonly signal?: AbortSignal;
}

interface MaterializedCheckpointEvidence {
  readonly text: string;
  readonly redactionCount: number;
  readonly truncated: boolean;
}

interface SessionFileIndex {
  readonly entries: ReadonlyMap<string, IndexedSessionEntry>;
  readonly memoryIds: ReadonlySet<string>;
}

interface IndexedSessionEntry {
  readonly lineNumber: number;
  readonly parent: IndexedParent;
  readonly hidden: boolean;
}

type IndexedParent =
  | { readonly kind: 'root' }
  | { readonly kind: 'id'; readonly value: string }
  | { readonly kind: 'invalid' };

interface BranchSelection {
  readonly ids: readonly string[];
  readonly positions: ReadonlyMap<string, number>;
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

  const index = await indexSessionFile(checkpoint.sessionFile, sourceBytes, signal);
  const current = selectVisibleBranch(index, checkpoint.leafId);
  const previous = previousCheckpoint
    ? selectVisibleBranch(index, previousCheckpoint.leafId)
    : undefined;
  const deltaStart = previous === undefined ? 0 : deltaStartIndex(current.ids, previous.ids);
  const writer = new BoundedTranscriptWriter(maxTranscriptBytes);
  const currentDigester = createActiveBranchDigester();
  const previousDigester = previous === undefined ? undefined : createActiveBranchDigester();
  let currentPosition = 0;
  let previousPosition = 0;

  await readSessionFileLines(checkpoint.sessionFile, sourceBytes, signal, (line, lineNumber) => {
    const value = parseSessionEntryLine(line);
    if (!value) return;
    const id = value.id as string;
    const indexed = index.entries.get(id);
    if (!indexed || indexed.lineNumber !== lineNumber) return;
    const currentIndex = current.positions.get(id);
    if (currentIndex !== undefined) {
      if (currentIndex !== currentPosition) {
        throw new MemoryInputMaterializationError('invalid_source', 'Memory checkpoint branch order is invalid');
      }
      const normalized = normalizeVisibleEntry(value, index);
      currentDigester.update(normalized);
      if (currentPosition >= deltaStart) {
        const redacted = redactTranscript(`${JSON.stringify(normalized)}\n`);
        writer.append(redacted.text, redacted.count);
      }
      currentPosition += 1;
    }
    const previousIndex = previous?.positions.get(id);
    if (previousIndex !== undefined) {
      if (previousIndex !== previousPosition) {
        throw new MemoryInputMaterializationError('invalid_source', 'Previously processed memory branch order is invalid');
      }
      previousDigester!.update(normalizeVisibleEntry(value, index));
      previousPosition += 1;
    }
  });

  if (currentPosition !== current.ids.length || currentDigester.digest() !== checkpoint.transcriptDigest) {
    throw new MemoryInputMaterializationError(
      'checkpoint_changed',
      'Memory checkpoint transcript changed before processing',
    );
  }
  if (previous !== undefined) {
    if (previousPosition !== previous.ids.length || previousDigester!.digest() !== previousCheckpoint!.transcriptDigest) {
      throw new MemoryInputMaterializationError(
        'previous_checkpoint_changed',
        'Previously processed memory checkpoint changed before processing',
      );
    }
  }
  return writer.finish();
}

async function indexSessionFile(
  sessionFile: string,
  sourceBytes: number,
  signal: AbortSignal | undefined,
): Promise<SessionFileIndex> {
  const entries = new Map<string, IndexedSessionEntry>();
  const memoryIds = new Set<string>();
  await readSessionFileLines(sessionFile, sourceBytes, signal, (line, lineNumber) => {
    const value = parseSessionEntryLine(line);
    if (!value) return;
    const id = value.id as string;
    const indexed = {
      lineNumber,
      parent: indexedParent(value.parentId),
      hidden: isMemoryContextEntry(value),
    } satisfies IndexedSessionEntry;
    entries.set(id, indexed);
    if (indexed.hidden) memoryIds.add(id);
  });
  return { entries, memoryIds };
}

function selectVisibleBranch(index: SessionFileIndex, leafId: string | null): BranchSelection {
  const visibleLeafId = visibleLeafIdFromIndex(index, leafId);
  if (visibleLeafId === null) return { ids: [], positions: new Map() };
  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | null = visibleLeafId;
  while (current !== null) {
    if (seen.has(current)) {
      throw new MemoryInputMaterializationError('invalid_source', 'Memory checkpoint transcript contains a cycle');
    }
    seen.add(current);
    const entry = index.entries.get(current);
    if (!entry || entry.hidden) {
      throw new MemoryInputMaterializationError('invalid_source', 'Memory checkpoint leaf is not present in the transcript');
    }
    path.push(current);
    const parent = normalizeParent(entry.parent, index);
    if (parent.kind === 'invalid') {
      throw new MemoryInputMaterializationError('invalid_source', 'Memory checkpoint branch has an invalid parent');
    }
    current = parent.kind === 'id' ? parent.value : null;
  }
  path.reverse();
  return {
    ids: path,
    positions: new Map(path.map((id, position) => [id, position])),
  };
}

function visibleLeafIdFromIndex(index: SessionFileIndex, leafId: string | null): string | null {
  let current = leafId;
  const seen = new Set<string>();
  while (current !== null && index.entries.get(current)?.hidden) {
    if (seen.has(current)) return null;
    seen.add(current);
    const parent: IndexedParent | undefined = index.entries.get(current)?.parent;
    current = parent?.kind === 'id' ? parent.value : null;
  }
  return current;
}

function normalizeVisibleEntry(value: Record<string, unknown>, index: SessionFileIndex): Record<string, unknown> {
  if (typeof value.parentId !== 'string' || !index.memoryIds.has(value.parentId)) return value;
  return { ...value, parentId: resolveVisibleParent(value.parentId, index) };
}

function resolveVisibleParent(id: string, index: SessionFileIndex): string | null {
  let current: string | null = id;
  const seen = new Set<string>();
  while (current !== null && index.memoryIds.has(current)) {
    if (seen.has(current)) return null;
    seen.add(current);
    const parent: IndexedParent | undefined = index.entries.get(current)?.parent;
    current = parent?.kind === 'id' ? parent.value : null;
  }
  return current;
}

function normalizeParent(parent: IndexedParent, index: SessionFileIndex): IndexedParent {
  if (parent.kind !== 'id' || !index.memoryIds.has(parent.value)) return parent;
  const visible = resolveVisibleParent(parent.value, index);
  return visible === null ? { kind: 'root' } : { kind: 'id', value: visible };
}

function indexedParent(value: unknown): IndexedParent {
  if (value === null) return { kind: 'root' };
  if (typeof value === 'string') return { kind: 'id', value };
  return { kind: 'invalid' };
}

function parseSessionEntryLine(line: string): Record<string, unknown> | undefined {
  if (line.trim().length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.type === 'session' || typeof value.id !== 'string') return undefined;
  return value;
}

async function readSessionFileLines(
  sessionFile: string,
  sourceBytes: number,
  signal: AbortSignal | undefined,
  callback: (line: string, lineNumber: number) => void,
): Promise<void> {
  if (sourceBytes === 0) return;
  const input = createReadStream(sessionFile, { encoding: 'utf8', start: 0, end: sourceBytes - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      throwIfAborted(signal);
      callback(line, lineNumber);
      lineNumber += 1;
    }
  } catch (error) {
    if (signal?.aborted || error instanceof MemoryInputMaterializationError) throw error;
    throw new MemoryInputMaterializationError('source_unavailable', 'Memory checkpoint source is unavailable');
  } finally {
    lines.close();
    input.destroy();
  }
}

function deltaStartIndex(current: readonly string[], previous: readonly string[]): number {
  const previousIds = new Set(previous);
  let commonIndex = -1;
  for (let index = 0; index < current.length; index += 1) {
    if (previousIds.has(current[index]!)) commonIndex = index;
  }
  return commonIndex + 1;
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

class BoundedTranscriptWriter {
  #text = '';
  #bytes = 0;
  #truncated = false;
  #redactionCount = 0;

  constructor(private readonly maxBytes: number) {}

  append(content: string, redactionCount = 0): void {
    this.#redactionCount += redactionCount;
    if (this.#truncated || content.length === 0) return;
    const available = this.maxBytes - this.#bytes;
    if (available <= 0) {
      this.#truncated = true;
      return;
    }
    if (Buffer.byteLength(content, 'utf8') <= available) {
      this.#text += content;
      this.#bytes += Buffer.byteLength(content, 'utf8');
      return;
    }
    this.#text += truncateUtf8(content, available);
    this.#bytes = Buffer.byteLength(this.#text, 'utf8');
    this.#truncated = true;
  }

  finish(): MaterializedCheckpointEvidence {
    return {
      text: this.#text,
      redactionCount: this.#redactionCount,
      truncated: this.#truncated,
    };
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

class RestrictedMemoryDreamRuntime implements AgentRuntime {
  readonly kind = 'host' as const;
  readonly cwd: string;

  constructor(
    private readonly base: HostAgentRuntime,
    cwd: string,
  ) {
    this.cwd = cwd;
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

function redactTranscript(content: string): { text: string; count: number } {
  let count = 0;
  const replace = (pattern: RegExp, replacement: string): void => {
    content = content.replace(pattern, (...args: unknown[]) => {
      count += 1;
      return replacement.replace('$1', String(args[1] ?? ''));
    });
  };
  replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '[REDACTED_PRIVATE_KEY]');
  replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/gu, '[REDACTED_TOKEN]');
  replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/giu, '$1[REDACTED_TOKEN]');
  replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]+/giu, '$1[REDACTED_SECRET]');
  return { text: content, count };
}

function truncateUtf8(content: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) return content;
  const marker = '\n[TRUNCATED]';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (maxBytes <= markerBytes) return utf8Prefix(marker, maxBytes);
  return `${utf8Prefix(content, maxBytes - markerBytes)}${marker}`;
}

function utf8Prefix(content: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) return content;
  let prefix = new TextDecoder().decode(Buffer.from(content, 'utf8').subarray(0, maxBytes));
  while (Buffer.byteLength(prefix, 'utf8') > maxBytes) prefix = prefix.slice(0, -1);
  return prefix;
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
