import { randomBytes } from 'node:crypto';
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
  readonly command: string;
  readonly process: AgentRuntimeProcess;
  readonly decoder: TextDecoder;
  readonly sanitizer: TerminalSanitizer;
  offset: number;
}

const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WRITE_YIELD_MS = 1_000;
const MAX_YIELD_MS = 30_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const MAX_RETAINED_OUTPUT_CHARS = 4 * 1024 * 1024;
const COMPLETED_HISTORY_LIMIT = 32;

export class ExecSessionManager {
  readonly #sessions = new Map<number, ExecSession>();
  readonly #completed = new Map<number, UnifiedExecResult>();
  #nextId = 1;

  constructor(private readonly runtime: AgentRuntime) {}

  async exec(
    input: ExecCommandInput,
    signal?: AbortSignal,
    onUpdate?: (result: UnifiedExecResult) => void,
  ): Promise<UnifiedExecResult> {
    const processes = this.runtime.processes;
    if (!processes) throw new Error('exec_command requires runtime process support');
    if (signal?.aborted) throw new Error('exec_command aborted');
    const startedAt = Date.now();
    const process = await processes.startShell(input.cmd, {
      ...(input.workdir === undefined ? {} : { cwd: input.workdir }),
      ...(input.shell === undefined ? {} : { shell: input.shell }),
      ...(input.login === undefined ? {} : { login: input.login }),
      stdin: input.tty === true,
    });
    const session: ExecSession = {
      id: this.#nextId++,
      command: input.cmd,
      process,
      decoder: new TextDecoder(),
      sanitizer: new TerminalSanitizer(),
      offset: 0,
    };
    this.#sessions.set(session.id, session);
    onUpdate?.(this.#emptyResult(session, startedAt));

    const abort = () => void process.terminate();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const snapshot = await readFor(
        session,
        0,
        clampYield(input.yield_time_ms, DEFAULT_EXEC_YIELD_MS),
        input.max_output_tokens,
        signal,
      );
      if (signal?.aborted) {
        this.#sessions.delete(session.id);
        await process.dispose();
        throw new Error('exec_command aborted');
      }
      session.offset = snapshot.nextOffset;
      const result = resultFromRead(session, snapshot, startedAt, input.max_output_tokens);
      if (!snapshot.running) await this.#complete(session, result);
      return result;
    } catch (error) {
      if (signal?.aborted && this.#sessions.has(session.id)) {
        await this.#discard(session);
        throw new Error('exec_command aborted', { cause: error });
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async write(
    input: WriteStdinInput,
    signal?: AbortSignal,
    onUpdate?: (result: UnifiedExecResult) => void,
  ): Promise<UnifiedExecResult> {
    const session = this.#sessions.get(input.session_id);
    if (signal?.aborted) {
      if (session) await this.#discard(session);
      throw new Error('write_stdin aborted');
    }
    if (!session) {
      const completed = this.#completed.get(input.session_id);
      if (completed && !(input.chars ?? '')) return truncateResult(completed, input.max_output_tokens);
      if (completed) throw new Error(`Process id ${input.session_id} already exited; cannot write stdin`);
      throw new Error(`Unknown process id ${input.session_id}`);
    }
    const startedAt = Date.now();
    const abort = () => void session.process.terminate();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (input.chars) await session.process.write(new TextEncoder().encode(input.chars));
      if (signal?.aborted) {
        await this.#discard(session);
        throw new Error('write_stdin aborted');
      }
      onUpdate?.(this.#emptyResult(session, startedAt));
      const snapshot = await readFor(
        session,
        session.offset,
        clampYield(input.yield_time_ms, DEFAULT_WRITE_YIELD_MS),
        input.max_output_tokens,
        signal,
      );
      if (signal?.aborted) {
        await this.#discard(session);
        throw new Error('write_stdin aborted');
      }
      session.offset = snapshot.nextOffset;
      const result = resultFromRead(session, snapshot, startedAt, input.max_output_tokens);
      if (!snapshot.running) await this.#complete(session, result);
      return result;
    } catch (error) {
      if (signal?.aborted && this.#sessions.has(session.id)) {
        await this.#discard(session);
        throw new Error('write_stdin aborted', { cause: error });
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  getSessionCommand(sessionId: number): string | undefined {
    return this.#sessions.get(sessionId)?.command;
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    this.#completed.clear();
    await Promise.all(sessions.map((session) => session.process.dispose()));
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
    this.#sessions.delete(session.id);
    this.#completed.set(session.id, result);
    while (this.#completed.size > COMPLETED_HISTORY_LIMIT) {
      const oldest = this.#completed.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.#completed.delete(oldest);
    }
    await session.process.dispose();
  }

  async #discard(session: ExecSession): Promise<void> {
    this.#sessions.delete(session.id);
    await session.process.dispose();
  }
}

export function formatExecResult(result: UnifiedExecResult, command?: string): string {
  const sections: string[] = [];
  if (command) sections.push(`Command: ${command}`);
  sections.push(`Chunk ID: ${result.chunk_id}`);
  sections.push(`Wall time: ${result.wall_time_seconds.toFixed(4)} seconds`);
  if (result.exit_code !== undefined) sections.push(`Process exited with code ${result.exit_code}`);
  if (result.session_id !== undefined) {
    sections.push(`Session ${result.session_id} still running. Resume near completion with write_stdin and an appropriate yield_time_ms`);
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
    output = tail(`${output}${sanitized}`, maxChars);
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
  const originalTokenCount = Math.ceil(Math.max(output.length, originalCharCount) / 4);
  if (output.length <= maxChars) {
    return output || originalCharCount > 0
      ? { output, original_token_count: originalTokenCount }
      : { output };
  }
  return {
    output: tail(output, maxChars),
    original_token_count: originalTokenCount,
  };
}

function maxCharsForTokens(maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS): number {
  const requested = Number.isFinite(maxOutputTokens)
    ? Math.max(256, Math.floor(maxOutputTokens * 4))
    : DEFAULT_MAX_OUTPUT_TOKENS * 4;
  return Math.min(MAX_RETAINED_OUTPUT_CHARS, requested);
}

function tail(output: string, maxChars: number): string {
  let start = Math.max(0, output.length - maxChars);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(output[start]!)) start += 1;
  return output.slice(start);
}

function clampYield(value: number | undefined, fallback: number): number {
  return Math.min(MAX_YIELD_MS, Math.max(250, value ?? fallback));
}

function chunkId(): string {
  return randomBytes(3).toString('hex');
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
