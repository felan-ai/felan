import type { AgentRuntime } from '@felan-ai/agent-core';
import { execCbm } from '../binary/exec.js';
import { parseCbmEnvelope, parseMaybeJson } from './envelope.js';
import type { CbmCallOptions, CbmCallResult } from './result.js';
import { DEFAULT_QUERY_TIMEOUT_MS, MAX_OUTPUT_BYTES } from './timeouts.js';

export interface CbmClientOptions { readonly queryTimeoutMs?: number }

export class CbmClient {
  constructor(
    private readonly runtime: AgentRuntime,
    readonly binary: string,
    private readonly options: CbmClientOptions = {},
  ) {}

  async findGitRoot(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    const result = await this.runtime.exec('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      timeout: 5_000,
      maxOutputBytes: 64 * 1024,
      ...(signal ? { signal } : {}),
    }).catch(() => undefined);
    return result && result.code === 0 && !result.killed ? result.stdout.trim() || undefined : undefined;
  }

  async gitRoot(cwd: string, signal?: AbortSignal): Promise<string> {
    return (await this.findGitRoot(cwd, signal)) ?? cwd;
  }

  async callTool(
    toolName: string,
    args: Readonly<Record<string, unknown>>,
    options: CbmCallOptions = {},
  ): Promise<CbmCallResult> {
    const result = await execCbm(this.runtime, this.binary, toolName, args, {
      timeoutMs: options.timeoutMs ?? this.options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (options.signal?.aborted) throw new Error(`codebase-memory-mcp ${toolName} cancelled`);
    if (result.truncated) throw new Error(`codebase-memory-mcp ${toolName} output exceeded ${MAX_OUTPUT_BYTES} bytes`);
    if (result.killed) throw new Error(`codebase-memory-mcp ${toolName} timed out or was terminated`);
    if (result.code !== 0 && !result.stdout.trim()) {
      throw new Error(`codebase-memory-mcp ${toolName} failed with exit code ${result.code}: ${result.stderr.trim()}`);
    }
    const { envelope, text } = parseCbmEnvelope(result.stdout);
    const data = parseMaybeJson(text);
    const ok = envelope.isError !== true;
    if (!ok && !options.allowError) throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
    return { ok, data, rawText: text, stderr: result.stderr };
  }
}
