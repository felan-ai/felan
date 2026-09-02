import { randomBytes, randomInt } from 'node:crypto';
import type { AgentRuntime, AgentRuntimeProcess } from '@felan-ai/agent-core';

export interface ExecCommandInput {
  readonly cmd: string;
  readonly workdir?: string;
  readonly shell?: string;
  readonly tty?: boolean;
  readonly yield_time_ms?: number;
  readonly max_output_tokens?: number;
  readonly login?: boolean;
}

export interface WriteStdinInput {
  readonly session_id: number;
  readonly chars?: string;
  readonly yield_time_ms?: number;
  readonly max_output_tokens?: number;
}

export interface UnifiedExecResult {
  readonly chunk_id: string;
  readonly wall_time_seconds: number;
  readonly output: string;
  readonly exit_code?: number;
  readonly session_id?: number;
  readonly original_token_count?: number;
}

interface ExecSession {
  readonly id: number;
  readonly process: AgentRuntimeProcess;
  readonly tty: boolean;
  readonly decoder: TextDecoder;
  readonly sanitizer: TerminalSanitizer;
  interactionTail: Promise<void>;
  offset: number;
  pendingOutput: string;
  pendingOriginalCharCount: number;
  disposePromise?: Promise<void>;
}

const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WRITE_YIELD_MS = 250;
const MIN_YIELD_MS = 250;
const MIN_EMPTY_POLL_YIELD_MS = 5_000;
const MAX_YIELD_MS = 30_000;
const MAX_EMPTY_POLL_YIELD_MS = 300_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
export const MAX_OUTPUT_TOKENS = 25_000;
const MAX_RETAINED_OUTPUT_CHARS = MAX_OUTPUT_TOKENS * 4;
const MAX_RETAINED_LINE_CHARS = 2_000;
const LONG_LINE_PATTERN = new RegExp(`[^\\n]{${MAX_RETAINED_LINE_CHARS + 1},}`, 'g');
const LINE_TRUNCATION_MARKER = '…[line truncated]';
const OUTPUT_TRUNCATION_MARKER = '\n[... output truncated ...]\n';
const COMPLETED_HISTORY_LIMIT = 32;
const SESSION_ID_MIN = 1_000;
const SESSION_ID_MAX_EXCLUSIVE = 100_000;

export class ExecSessionManager {
  readonly #sessions = new Map<number, ExecSession>();
  readonly #completed = new Map<number, UnifiedExecResult>();
  readonly #starting = new Set<Promise<void>>();
  readonly #shutdownFailures: unknown[] = [];
  #shuttingDown = false;
  #shutdownPromise?: Promise<void>;

  constructor(private readonly runtime: AgentRuntime) {}

  async exec(
    input: ExecCommandInput,
    signal?: AbortSignal,
    onUpdate?: (result: UnifiedExecResult) => void,
  ): Promise<UnifiedExecResult> {
    this.#assertAvailable();
    const processes = this.runtime.processes;
    if (!processes) throw new Error('exec_command requires runtime process support');
    if (signal?.aborted) throw new Error('exec_command aborted');
    const startedAt = Date.now();
    const processOptions = {
      ...(input.workdir === undefined ? {} : { cwd: input.workdir }),
      ...(input.shell === undefined ? {} : { shell: input.shell }),
      ...(input.login === undefined ? {} : { login: input.login }),
    };
    const session = await this.#startSession(input, processOptions, processes);
    this.#assertAvailable();
    try {
      return await this.#withInteraction(session, async () => {
        onUpdate?.(this.#emptyResult(session, startedAt));
        const snapshot = await readFor(
          session,
          0,
          execYield(input.yield_time_ms),
          input.max_output_tokens,
          signal,
        );
        session.offset = snapshot.nextOffset;
        if (signal?.aborted) {
          await this.#preserveAbortedRead(session, snapshot, startedAt);
          throw new Error(`exec_command aborted; process continues as session ${session.id}`);
        }
        const result = this.#consumeRead(session, snapshot, startedAt, input.max_output_tokens);
        if (!snapshot.running) await this.#complete(session, result);
        return result;
      });
    } catch (error) {
      if (signal?.aborted && !String(error).includes(`session ${session.id}`)) {
        throw new Error(`exec_command aborted; process continues as session ${session.id}`, { cause: error });
      }
      throw error;
    }
  }

  async write(
    input: WriteStdinInput,
    signal?: AbortSignal,
    onUpdate?: (result: UnifiedExecResult) => void,
  ): Promise<UnifiedExecResult> {
    this.#assertAvailable();
    const session = this.#sessions.get(input.session_id);
    if (!session) {
      return this.#completedResult(input);
    }
    const startedAt = Date.now();
    try {
      return await this.#withInteraction(session, async () => {
        this.#assertAvailable();
        if (this.#sessions.get(input.session_id) !== session) return this.#completedResult(input);
        const chars = input.chars ?? '';
        if (chars) {
          this.#validateInput(session, chars);
          await this.#writeInput(session, chars);
        }
        if (signal?.aborted) {
          throw new Error(`write_stdin aborted; session ${session.id} remains available`);
        }
        onUpdate?.(this.#emptyResult(session, startedAt));
        const snapshot = await readFor(
          session,
          session.offset,
          writeYield(chars, input.yield_time_ms),
          input.max_output_tokens,
          signal,
        );
        session.offset = snapshot.nextOffset;
        if (signal?.aborted) {
          await this.#preserveAbortedRead(session, snapshot, startedAt);
          throw new Error(`write_stdin aborted; session ${session.id} remains available`);
        }
        const result = this.#consumeRead(session, snapshot, startedAt, input.max_output_tokens);
        if (!snapshot.running) await this.#complete(session, result);
        return result;
      });
    } catch (error) {
      if (signal?.aborted && !String(error).includes(`session ${session.id}`)) {
        throw new Error(`write_stdin aborted; session ${session.id} remains available`, { cause: error });
      }
      throw error;
    }
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shuttingDown = true;
    this.#shutdownPromise = this.#finishShutdown();
    return this.#shutdownPromise;
  }

  #emptyResult(session: ExecSession, startedAt: number): UnifiedExecResult {
    return {
      chunk_id: chunkId(),
      wall_time_seconds: (Date.now() - startedAt) / 1_000,
      output: '',
      session_id: session.id,
    };
  }

  async #complete(session: ExecSession, result: UnifiedExecResult): Promise<void> {
    try {
      await this.#disposeSession(session);
    } finally {
      if (this.#sessions.get(session.id) === session) this.#sessions.delete(session.id);
    }
    if (this.#shuttingDown) return;
    this.#completed.set(session.id, result);
    while (this.#completed.size > COMPLETED_HISTORY_LIMIT) {
      const oldest = this.#completed.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.#completed.delete(oldest);
    }
  }

  async #startSession(
    input: ExecCommandInput,
    options: Parameters<NonNullable<AgentRuntime['processes']>['startShell']>[1],
    processes: NonNullable<AgentRuntime['processes']>,
  ): Promise<ExecSession> {
    let finishStart!: () => void;
    const starting = new Promise<void>((resolveStart) => { finishStart = resolveStart; });
    this.#starting.add(starting);
    let process: AgentRuntimeProcess | undefined;
    try {
      process = input.tty === true
        ? await this.#startTerminal(input.cmd, options)
        : await processes.startShell(input.cmd, options);
      this.#assertAvailable();
      const session: ExecSession = {
        id: this.#allocateSessionId(),
        process,
        tty: input.tty === true,
        decoder: new TextDecoder(),
        sanitizer: new TerminalSanitizer(),
        interactionTail: Promise.resolve(),
        offset: 0,
        pendingOutput: '',
        pendingOriginalCharCount: 0,
      };
      this.#sessions.set(session.id, session);
      process = undefined;
      return session;
    } finally {
      try {
        if (process) {
          try {
            await process.dispose();
          } catch (error) {
            if (this.#shuttingDown) this.#shutdownFailures.push(error);
            throw error;
          }
        }
      } finally {
        this.#starting.delete(starting);
        finishStart();
      }
    }
  }

  async #finishShutdown(): Promise<void> {
    await Promise.allSettled([...this.#starting]);
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    this.#completed.clear();
    const results = await Promise.allSettled(sessions.map((session) => this.#disposeSession(session)));
    const failures = [
      ...this.#shutdownFailures,
      ...results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
    ];
    if (failures.length > 0) throw new AggregateError(failures, 'Failed to shut down exec sessions');
  }

  #disposeSession(session: ExecSession): Promise<void> {
    session.disposePromise ??= Promise.resolve().then(() => session.process.dispose());
    return session.disposePromise;
  }

  #assertAvailable(): void {
    if (this.#shuttingDown) throw new Error('exec manager is shut down');
  }

  async #startTerminal(
    command: string,
    options: Parameters<NonNullable<AgentRuntime['processes']>['startShell']>[1],
  ): Promise<AgentRuntimeProcess> {
    if (!this.runtime.terminals) {
      throw new Error('exec_command with tty=true requires runtime terminal support');
    }
    return this.runtime.terminals.startShell(command, options);
  }

  async #writeInput(session: ExecSession, chars: string): Promise<void> {
    if (session.tty) {
      await session.process.write(new TextEncoder().encode(chars));
      await delay(100);
      return;
    }
    await session.process.interrupt!();
  }

  #validateInput(session: ExecSession, chars: string): void {
    if (session.tty) return;
    if (chars !== '\u0003') {
      throw new Error('stdin is closed for this session; rerun exec_command with tty=true to keep stdin open');
    }
    if (!session.process.interrupt) throw new Error('Runtime process interruption is unavailable');
  }

  #completedResult(input: WriteStdinInput): UnifiedExecResult {
    const completed = this.#completed.get(input.session_id);
    if (completed && !(input.chars ?? '')) return truncateResult(completed, input.max_output_tokens);
    if (completed) throw new Error(`Process id ${input.session_id} already exited; cannot write stdin`);
    throw new Error(`Unknown process id ${input.session_id}`);
  }

  #consumeRead(
    session: ExecSession,
    read: ProcessReadResult,
    startedAt: number,
    maxOutputTokens?: number,
  ): UnifiedExecResult {
    const output = `${session.pendingOutput}${read.output}`;
    const originalCharCount = session.pendingOriginalCharCount + read.originalCharCount;
    session.pendingOutput = '';
    session.pendingOriginalCharCount = 0;
    return resultFromRead(
      session,
      { ...read, output, originalCharCount },
      startedAt,
      maxOutputTokens,
    );
  }

  async #preserveAbortedRead(
    session: ExecSession,
    read: ProcessReadResult,
    startedAt: number,
  ): Promise<void> {
    const combined = `${session.pendingOutput}${read.output}`;
    session.pendingOutput = headAndTail(clampLongLines(combined), MAX_RETAINED_OUTPUT_CHARS);
    session.pendingOriginalCharCount += read.originalCharCount;
    if (!read.running) {
      const result = this.#consumeRead(
        session,
        { ...read, output: '', originalCharCount: 0 },
        startedAt,
        MAX_RETAINED_OUTPUT_CHARS / 4,
      );
      await this.#complete(session, result);
    }
  }

  async #withInteraction<T>(
    session: ExecSession,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = session.interactionTail;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    session.interactionTail = previous.then(() => gate);
    try {
      await previous;
      return await operation();
    } finally {
      release();
    }
  }

  #allocateSessionId(): number {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const id = randomInt(SESSION_ID_MIN, SESSION_ID_MAX_EXCLUSIVE);
      if (!this.#sessions.has(id) && !this.#completed.has(id)) return id;
    }
    throw new Error('Unable to allocate a unified exec session id');
  }

}

export function formatExecResult(result: UnifiedExecResult): string {
  const sections: string[] = [];
  sections.push(`Chunk ID: ${result.chunk_id}`);
  sections.push(`Wall time: ${result.wall_time_seconds.toFixed(4)} seconds`);
  if (result.exit_code !== undefined) sections.push(`Process exited with code ${result.exit_code}`);
  if (result.session_id !== undefined) {
    sections.push(`Process running with session ID ${result.session_id}`);
  }
  if (result.original_token_count !== undefined) {
    sections.push(`Original token count: ${result.original_token_count}`);
  }
  sections.push('Output:', result.output);
  return sections.join('\n');
}

interface ProcessReadResult {
  readonly output: string;
  readonly originalCharCount: number;
  readonly nextOffset: number;
  readonly running: boolean;
  readonly exitCode?: number;
}

function resultFromRead(
  session: ExecSession,
  read: ProcessReadResult,
  startedAt: number,
  maxOutputTokens?: number,
): UnifiedExecResult {
  const truncated = truncateOutput(read.output, maxOutputTokens, read.originalCharCount);
  return {
    chunk_id: chunkId(),
    wall_time_seconds: (Date.now() - startedAt) / 1_000,
    ...truncated,
    ...(read.running ? { session_id: session.id } : { exit_code: read.exitCode ?? 1 }),
  };
}

async function readFor(
  session: ExecSession,
  afterOffset: number,
  waitMs: number,
  maxOutputTokens?: number,
  signal?: AbortSignal,
): Promise<ProcessReadResult> {
  const deadline = Date.now() + waitMs;
  const maxChars = maxCharsForTokens(maxOutputTokens);
  let output = '';
  let originalCharCount = 0;
  let offset = afterOffset;
  let snapshot = await session.process.read(offset);
  while (true) {
    const decoded = session.decoder.decode(snapshot.output, { stream: snapshot.running });
    const sanitized = session.sanitizer.write(decoded, !snapshot.running);
    originalCharCount += sanitized.length;
    output = headAndTail(clampLongLines(`${output}${sanitized}`), maxChars);
    offset = snapshot.nextOffset;
    if (!snapshot.running || signal?.aborted) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    snapshot = await session.process.read(offset, {
      waitMs: remaining,
      ...(signal === undefined ? {} : { signal }),
    });
    if (snapshot.output.length === 0 && snapshot.running) break;
  }
  return {
    output,
    originalCharCount,
    nextOffset: snapshot.nextOffset,
    running: snapshot.running,
    ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
  };
}

function truncateResult(result: UnifiedExecResult, maxOutputTokens?: number): UnifiedExecResult {
  const originalCharCount = result.original_token_count === undefined
    ? result.output.length
    : result.original_token_count * 4;
  return { ...result, ...truncateOutput(result.output, maxOutputTokens, originalCharCount) };
}

function truncateOutput(
  output: string,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  originalCharCount = output.length,
): {
  output: string;
  original_token_count?: number;
} {
  const maxChars = maxCharsForTokens(maxOutputTokens);
  const clampedOutput = clampLongLines(output);
  const originalTokenCount = Math.ceil(Math.max(output.length, originalCharCount) / 4);
  if (clampedOutput.length <= maxChars) {
    return clampedOutput || originalCharCount > 0
      ? { output: clampedOutput, original_token_count: originalTokenCount }
      : { output: clampedOutput };
  }
  return {
    output: headAndTail(clampedOutput, maxChars),
    original_token_count: originalTokenCount,
  };
}

function maxCharsForTokens(maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS): number {
  const requested = Number.isFinite(maxOutputTokens)
    ? Math.max(256, Math.floor(maxOutputTokens * 4))
    : DEFAULT_MAX_OUTPUT_TOKENS * 4;
  return Math.min(MAX_RETAINED_OUTPUT_CHARS, requested);
}

function clampLongLines(output: string): string {
  return output.replace(
    LONG_LINE_PATTERN,
    (line) => `${safeHead(line, MAX_RETAINED_LINE_CHARS)}${LINE_TRUNCATION_MARKER}`,
  );
}

function headAndTail(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;
  const retained = maxChars - OUTPUT_TRUNCATION_MARKER.length;
  if (retained <= 0) return safeHead(output, maxChars);
  const head = safeHead(output, Math.ceil(retained / 2));
  const tail = safeTail(output, Math.floor(retained / 2));
  return `${head}${OUTPUT_TRUNCATION_MARKER}${tail}`;
}

function safeHead(output: string, maxChars: number): string {
  let end = Math.min(output.length, Math.max(0, maxChars));
  if (end > 0 && /[\uD800-\uDBFF]/u.test(output[end - 1]!)) end -= 1;
  return output.slice(0, end);
}

function safeTail(output: string, maxChars: number): string {
  let start = Math.max(0, output.length - maxChars);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(output[start]!)) start += 1;
  return output.slice(start);
}

function execYield(value: number | undefined): number {
  const minimum = process.platform === 'win32' ? DEFAULT_EXEC_YIELD_MS : MIN_YIELD_MS;
  return clampYield(value ?? DEFAULT_EXEC_YIELD_MS, minimum, MAX_YIELD_MS);
}

function writeYield(chars: string, value: number | undefined): number {
  const requested = value ?? DEFAULT_WRITE_YIELD_MS;
  return chars
    ? clampYield(requested, MIN_YIELD_MS, MAX_YIELD_MS)
    : clampYield(requested, MIN_EMPTY_POLL_YIELD_MS, MAX_EMPTY_POLL_YIELD_MS);
}

function clampYield(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function chunkId(): string {
  return randomBytes(3).toString('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

type TerminalState =
  | 'text'
  | 'escape'
  | 'escape-intermediate'
  | 'csi'
  | 'osc'
  | 'osc-escape'
  | 'string'
  | 'string-escape';

class TerminalSanitizer {
  #state: TerminalState = 'text';

  write(input: string, final: boolean): string {
    let output = '';
    for (const character of input) {
      const code = character.codePointAt(0)!;
      switch (this.#state) {
        case 'text':
          if (code === 0x1b) this.#state = 'escape';
          else if (code === 0x9b) this.#state = 'csi';
          else if (code === 0x9d) this.#state = 'osc';
          else if ([0x90, 0x98, 0x9e, 0x9f].includes(code)) this.#state = 'string';
          else if (character === '\t' || character === '\n' || (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f))) {
            output += character;
          }
          break;
        case 'escape':
          if (character === '[') this.#state = 'csi';
          else if (character === ']') this.#state = 'osc';
          else if (character === 'P' || character === 'X' || character === '^' || character === '_') this.#state = 'string';
          else if (code >= 0x20 && code <= 0x2f) this.#state = 'escape-intermediate';
          else this.#state = 'text';
          break;
        case 'escape-intermediate':
          if (code >= 0x30 && code <= 0x7e) this.#state = 'text';
          break;
        case 'csi':
          if (code >= 0x40 && code <= 0x7e) this.#state = 'text';
          break;
        case 'osc':
          if (code === 0x07) this.#state = 'text';
          else if (code === 0x1b) this.#state = 'osc-escape';
          break;
        case 'osc-escape':
          this.#state = character === '\\' ? 'text' : 'osc';
          break;
        case 'string':
          if (code === 0x1b) this.#state = 'string-escape';
          break;
        case 'string-escape':
          this.#state = character === '\\' ? 'text' : 'string';
          break;
      }
    }
    if (final) this.#state = 'text';
    return output;
  }
}
