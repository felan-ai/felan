import type { AgentRuntime, ExecResult } from '@felan-ai/agent-core';
import {
  codebaseMemoryRuntimeDirectory,
  joinRuntimePath,
  shellQuote,
} from './runtime-path.js';

export const CODEBASE_MEMORY_VERSION = '0.10.8';
export const QUERY_TIMEOUT_MS = 60_000;
export const INDEX_TIMEOUT_MS = 20 * 60_000;
export const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

export interface CbmInvocation {
  readonly command: string;
  readonly version: string;
  readonly source: 'managed' | 'path';
}

export type CbmDetection =
  | { readonly available: true; readonly invocation: CbmInvocation }
  | { readonly available: false; readonly reason: string };

export interface CbmCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface CbmCallResult {
  readonly data: unknown;
  readonly stderr: string;
}

export class CbmClient {
  readonly cacheRoot: string;
  readonly runtimeRoot: string;
  readonly #runtimeStoragePath: string | undefined;

  constructor(
    private readonly runtime: AgentRuntime,
    readonly invocation: CbmInvocation,
  ) {
    const agentStorageRoot = runtime.storage('agent').root;
    const runtimeDirectory = codebaseMemoryRuntimeDirectory(agentStorageRoot);
    this.cacheRoot = joinRuntimePath(agentStorageRoot, 'codebase-memory/cache');
    this.runtimeRoot = runtimeDirectory.root;
    this.#runtimeStoragePath = runtimeDirectory.storagePath;
  }

  async call(command: string, args: Record<string, unknown>, options: CbmCallOptions = {}): Promise<CbmCallResult> {
    const timeout = options.timeoutMs ?? (command === 'index_repository' ? INDEX_TIMEOUT_MS : QUERY_TIMEOUT_MS);
    if (this.#runtimeStoragePath) {
      await this.runtime.storage('agent').mkdir(this.#runtimeStoragePath, { recursive: true });
    }
    const encoded = JSON.stringify(args);
    const invocation = [
      shellQuote(this.invocation.command),
      'cli',
      '--json',
      shellQuote(command),
      shellQuote(encoded),
    ].join(' ');
    const shellCommand = this.#runtimeStoragePath
      ? invocation
      : `umask 077 && mkdir -p -- ${shellQuote(this.runtimeRoot)} && ${invocation}`;
    const result = await this.runtime.shell(shellCommand, {
      cwd: this.runtime.cwd,
      env: { CBM_CACHE_DIR: this.cacheRoot, CBM_RUNTIME_DIR: this.runtimeRoot },
      maxOutputBytes: MAX_OUTPUT_BYTES,
      shellFlavor: 'posix',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeout,
    });
    return parseResult(command, result);
  }
}

export async function detectCbm(runtime: AgentRuntime): Promise<CbmDetection> {
  const candidates: Array<Omit<CbmInvocation, 'version'>> = [
    {
      command: joinRuntimePath(runtime.storage('agent').root, 'codebase-memory/bin/codebase-memory-mcp'),
      source: 'managed',
    },
    { command: 'codebase-memory-mcp', source: 'path' },
  ];
  for (const candidate of candidates) {
    let result: ExecResult;
    try {
      result = await runtime.exec(candidate.command, ['--version'], {
        cwd: runtime.cwd,
        maxOutputBytes: 64 * 1024,
        timeout: 5_000,
      });
    } catch {
      continue;
    }
    if (result.code !== 0 || result.killed) continue;
    const version = `${result.stdout}\n${result.stderr}`.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];
    if (version && isCompatibleVersion(version)) return { available: true, invocation: { ...candidate, version } };
  }
  return {
    available: false,
    reason: `Compatible codebase-memory-mcp ${CODEBASE_MEMORY_VERSION} is not installed.`,
  };
}

function isCompatibleVersion(version: string): boolean {
  return version === CODEBASE_MEMORY_VERSION;
}

function parseResult(command: string, result: ExecResult): CbmCallResult {
  if (result.killed) throw new Error(`${command} timed out or was cancelled`);
  if (result.truncated) throw new Error(`${command} exceeded the ${MAX_OUTPUT_BYTES}-byte output limit`);
  if (result.code !== 0) throw new Error(sanitize(result.stderr || result.stdout || `${command} exited ${result.code}`));
  const trimmed = result.stdout.trim();
  if (!trimmed) throw new Error(`${command} produced no JSON output`);
  let envelope: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  try {
    envelope = JSON.parse(trimmed) as typeof envelope;
  } catch {
    const candidate = trimmed.split(/\r?\n/u).reverse().find((line) => line.trim().startsWith('{'));
    if (!candidate) throw new Error(`${command} produced invalid JSON output`);
    envelope = JSON.parse(candidate) as typeof envelope;
  }
  const text = envelope.content?.find((block) => block.type === 'text' && typeof block.text === 'string')?.text;
  if (text === undefined) throw new Error(`${command} returned an envelope with no text content`);
  let data: unknown = text;
  try { data = JSON.parse(text); } catch { /* Preserve non-JSON upstream text. */ }
  if (envelope.isError) throw new Error(sanitize(typeof data === 'string' ? data : JSON.stringify(data)));
  return { data, stderr: sanitize(result.stderr) };
}

function sanitize(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 1_000);
}
