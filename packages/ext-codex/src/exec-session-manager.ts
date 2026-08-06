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
  offset: number;
}

const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WRITE_YIELD_MS = 1_000;
const MAX_YIELD_MS = 1_800_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
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
      offset: 0,
    };
    this.#sessions.set(session.id, session);
    onUpdate?.(this.#emptyResult(session, startedAt));

    const abort = () => void process.terminate();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const snapshot = await readFor(
        process,
        0,
        clampYield(input.yield_time_ms, DEFAULT_EXEC_YIELD_MS),
        signal,
      );
      if (signal?.aborted) {
        this.#sessions.delete(session.id);
        await process.dispose();
        throw new Error('exec_command aborted');
      }
      session.offset = snapshot.nextOffset;
      const result = resultFromSnapshot(session, snapshot, startedAt, input.max_output_tokens);
      if (!snapshot.running) await this.#complete(session, result);
      return result;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async write(
    input: WriteStdinInput,
    signal?: AbortSignal,
    onUpdate?: (result: UnifiedExecResult) => void,
  ): Promise<UnifiedExecResult> {
    if (signal?.aborted) throw new Error('write_stdin aborted');
    const session = this.#sessions.get(input.session_id);
    if (!session) {
      const completed = this.#completed.get(input.session_id);
      if (completed && !(input.chars ?? '')) return truncateResult(completed, input.max_output_tokens);
      if (completed) throw new Error(`Process id ${input.session_id} already exited; cannot write stdin`);
      throw new Error(`Unknown process id ${input.session_id}`);
    }
    const startedAt = Date.now();
    if (input.chars) await session.process.write(new TextEncoder().encode(input.chars));
    onUpdate?.(this.#emptyResult(session, startedAt));
    const abort = () => void session.process.terminate();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const snapshot = await readFor(
        session.process,
        session.offset,
        clampYield(input.yield_time_ms, DEFAULT_WRITE_YIELD_MS),
        signal,
      );
      if (signal?.aborted) throw new Error('write_stdin aborted');
      session.offset = snapshot.nextOffset;
      const result = resultFromSnapshot(session, snapshot, startedAt, input.max_output_tokens);
      if (!snapshot.running) await this.#complete(session, result);
      return result;
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

function resultFromSnapshot(
  session: ExecSession,
  snapshot: Awaited<ReturnType<AgentRuntimeProcess['read']>>,
  startedAt: number,
  maxOutputTokens?: number,
): UnifiedExecResult {
  const output = new TextDecoder().decode(snapshot.output);
  const truncated = truncateOutput(output, maxOutputTokens);
  return {
    chunk_id: chunkId(),
    wall_time_seconds: (Date.now() - startedAt) / 1_000,
    ...truncated,
    ...(snapshot.running ? { session_id: session.id } : { exit_code: snapshot.exitCode ?? 1 }),
  };
}

async function readFor(
  process: AgentRuntimeProcess,
  afterOffset: number,
  waitMs: number,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<AgentRuntimeProcess['read']>>> {
  const deadline = Date.now() + waitMs;
  const chunks: Uint8Array[] = [];
  let offset = afterOffset;
  let snapshot = await process.read(offset);
  let collected = false;
  while (snapshot.running && !signal?.aborted) {
    if (snapshot.output.length > 0) chunks.push(snapshot.output);
    collected = true;
    offset = snapshot.nextOffset;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    snapshot = await process.read(offset, {
      waitMs: remaining,
      ...(signal === undefined ? {} : { signal }),
    });
    collected = false;
    if (snapshot.output.length === 0 && snapshot.running) break;
  }
  if (!collected && snapshot.output.length > 0) chunks.push(snapshot.output);
  return {
    ...snapshot,
    output: concatBytes(chunks),
    nextOffset: snapshot.nextOffset,
  };
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function truncateResult(result: UnifiedExecResult, maxOutputTokens?: number): UnifiedExecResult {
  return { ...result, ...truncateOutput(result.output, maxOutputTokens) };
}

function truncateOutput(output: string, maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS): {
  output: string;
  original_token_count?: number;
} {
  const maxChars = Math.max(256, maxOutputTokens * 4);
  if (output.length <= maxChars) {
    return output ? { output, original_token_count: Math.ceil(output.length / 4) } : { output };
  }
  return {
    output: output.slice(-maxChars),
    original_token_count: Math.ceil(output.length / 4),
  };
}

function clampYield(value: number | undefined, fallback: number): number {
  return Math.min(MAX_YIELD_MS, Math.max(250, value ?? fallback));
}

function chunkId(): string {
  return randomBytes(3).toString('hex');
}
