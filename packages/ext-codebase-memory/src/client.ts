import type { AgentRuntime, AgentRuntimeStdioProcess, ExecResult } from '@felan-ai/agent-core';
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

export interface CbmClientLease {
  readonly client: CbmClient;
  release(): Promise<void>;
}

interface SharedCbmClient {
  readonly client: CbmClient;
  references: number;
  closing?: Promise<void>;
}

const sharedClients = new Map<string, SharedCbmClient>();

export async function acquireCbmClient(runtime: AgentRuntime, invocation: CbmInvocation): Promise<CbmClientLease> {
  if (!runtime.processes?.startStdio) {
    const client = new CbmClient(runtime, invocation);
    return clientLease(client, () => client.close());
  }

  const key = sharedClientKey(runtime, invocation);
  let shared = sharedClients.get(key);
  if (shared?.closing) {
    await shared.closing;
    shared = sharedClients.get(key);
  }
  if (!shared) {
    shared = { client: new CbmClient(runtime, invocation), references: 0 };
    sharedClients.set(key, shared);
  }
  const entry = shared;
  entry.references += 1;
  return clientLease(entry.client, async () => {
    entry.references -= 1;
    if (entry.references > 0) return;
    const closing = entry.client.close().finally(() => {
      if (sharedClients.get(key) === entry) sharedClients.delete(key);
    });
    entry.closing = closing;
    await closing;
  });
}

function clientLease(client: CbmClient, releaseClient: () => Promise<void>): CbmClientLease {
  let released = false;
  return {
    client,
    async release() {
      if (released) return;
      released = true;
      await releaseClient();
    },
  };
}

function sharedClientKey(runtime: AgentRuntime, invocation: CbmInvocation): string {
  // Session storage is shared by a root and its descendants but isolated between top-level sessions.
  return [
    runtime.storage('session').root,
    runtime.storage('agent').root,
    invocation.source,
    invocation.command,
    invocation.version,
  ].join('\u0000');
}

export class CbmClient {
  readonly cacheRoot: string;
  readonly runtimeRoot: string;
  readonly #runtimeStoragePath: string | undefined;
  #session: CbmMcpSession | undefined;
  #sessionStart: Promise<CbmMcpSession> | undefined;
  #closed = false;

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
    if (this.#closed) throw new Error('Codebase Memory client is closed');
    if (!this.runtime.processes?.startStdio) return this.#callOneShot(command, args, options, timeout);
    const session = await this.#getSession();
    try {
      return await session.call(command, args, timeout, options.signal);
    } catch (error) {
      if (!session.isUsable && this.#session === session) this.#session = undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#closeSession();
  }

  async #closeSession(): Promise<void> {
    const session = this.#session;
    const starting = this.#sessionStart;
    this.#session = undefined;
    this.#sessionStart = undefined;
    await session?.close();
    const started = await starting?.catch(() => undefined);
    if (started && started !== session) await started.close();
  }

  async #getSession(): Promise<CbmMcpSession> {
    const startStdio = this.runtime.processes?.startStdio;
    if (!startStdio) throw new Error('Codebase Memory stdio transport is unavailable');
    if (this.#sessionStart) return this.#sessionStart;
    if (this.#session) return this.#session;
    const starting = this.#startSession(startStdio);
    this.#sessionStart = starting;
    const session = await starting.finally(() => {
      if (this.#sessionStart === starting) this.#sessionStart = undefined;
    });
    if (!this.#closed) this.#session = session;
    return session;
  }

  async #startSession(startStdio: NonNullable<NonNullable<AgentRuntime['processes']>['startStdio']>): Promise<CbmMcpSession> {
    const runtimeDirectory = this.#runtimeStoragePath
      ? await this.runtime.storage('agent').mkdir(this.#runtimeStoragePath, { recursive: true }).then(() => this.runtimeRoot)
      : this.runtime.privateRuntime
        ? await this.runtime.privateRuntime.ensureDirectory(this.runtimeRoot.slice('/tmp/'.length))
        : (() => { throw new Error('Codebase Memory requires a private runtime directory capability'); })();
    const process = await startStdio(this.invocation.command, [], {
      cwd: this.runtime.cwd,
      env: { CBM_CACHE_DIR: this.cacheRoot, CBM_RUNTIME_DIR: runtimeDirectory },
    });
    const session = new CbmMcpSession(process);
    if (!this.#closed) this.#session = session;
    try {
      await session.start();
      return session;
    } catch (error) {
      if (this.#session === session) this.#session = undefined;
      await session.close().catch(() => {});
      throw error;
    }
  }

  async #callOneShot(command: string, args: Record<string, unknown>, options: CbmCallOptions, timeout: number): Promise<CbmCallResult> {
    const runtimeDirectory = this.#runtimeStoragePath
      ? await this.runtime.storage('agent').mkdir(this.#runtimeStoragePath, { recursive: true }).then(() => this.runtimeRoot)
      : this.runtime.privateRuntime
        ? await this.runtime.privateRuntime.ensureDirectory(this.runtimeRoot.slice('/tmp/'.length))
        : (() => { throw new Error('Codebase Memory requires a private runtime directory capability'); })();
    const encoded = JSON.stringify(args);
    const invocation = [shellQuote(this.invocation.command), 'cli', '--json', shellQuote(command), shellQuote(encoded)].join(' ');
    const result = await this.runtime.shell(invocation, {
      cwd: this.runtime.cwd,
      env: { CBM_CACHE_DIR: this.cacheRoot, CBM_RUNTIME_DIR: runtimeDirectory },
      maxOutputBytes: MAX_OUTPUT_BYTES,
      shellFlavor: 'posix',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeout,
    });
    return parseResult(command, result);
  }
}

class CbmMcpSession {
  #nextId = 1;
  #stdoutOffset = 0;
  #stderrOffset = 0;
  #reader: Promise<void> | undefined;
  #stderrReader: Promise<void> | undefined;
  #pending = new Map<number, { resolve: (value: CbmCallResult) => void; reject: (error: Error) => void }>();
  #buffer = '';
  #stderr = '';
  #usable = true;
  #closed = false;
  readonly #stdoutDecoder = new TextDecoder();
  readonly #stderrDecoder = new TextDecoder();

  constructor(private readonly process: AgentRuntimeStdioProcess) {}

  get isUsable(): boolean { return this.#usable && !this.#closed; }

  async start(): Promise<void> {
    this.#reader = this.#readStdout();
    this.#stderrReader = this.#readStderr();
    await this.#request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'felan', version: '0.19.2' },
    }, 30_000);
    await this.process.write(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`));
  }

  call(command: string, args: Record<string, unknown>, timeout: number, signal?: AbortSignal): Promise<CbmCallResult> {
    return this.#request('tools/call', { name: command, arguments: args }, timeout, signal);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#usable = false;
    const error = new Error('Codebase Memory session closed');
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    await this.process.closeInput().catch(() => {});
    await waitForProcess(this.process, 500).catch(() => {});
    await this.process.dispose().catch(() => {});
    await Promise.allSettled([this.#reader, this.#stderrReader].filter((value): value is Promise<void> => value !== undefined));
  }

  #request(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<CbmCallResult> {
    if (!this.isUsable) return Promise.reject(new Error('Codebase Memory session is unavailable'));
    const id = this.#nextId++;
    const message = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    return new Promise<CbmCallResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        if (!this.#pending.delete(id)) return;
        if (timer) clearTimeout(timer);
        void this.process.write(new TextEncoder().encode(`${JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: id, reason: signal?.aborted ? 'cancelled' : 'timeout' },
        })}\n`)).catch((error: unknown) => this.#fail(error));
        reject(new Error(`${method} timed out or was cancelled`));
      };
      this.#pending.set(id, { resolve: (value) => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(value); }, reject: (error) => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); } });
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, timeoutMs);
      void this.process.write(new TextEncoder().encode(message)).catch((error: unknown) => this.#fail(error));
    });
  }

  async #readStdout(): Promise<void> {
    try {
      while (this.isUsable) {
        const snapshot = await this.process.readStdout(this.#stdoutOffset, { waitMs: 1_000, maxBytes: MAX_OUTPUT_BYTES });
        this.#stdoutOffset = snapshot.nextOffset;
        this.#buffer += this.#stdoutDecoder.decode(snapshot.output, { stream: snapshot.running });
        if (Buffer.byteLength(this.#buffer) > MAX_OUTPUT_BYTES) { this.#fail(new Error('Codebase Memory stdout exceeded the output limit')); return; }
        let newline = this.#buffer.indexOf('\n');
        while (newline >= 0) {
          const line = this.#buffer.slice(0, newline).replace(/\r$/u, '');
          this.#buffer = this.#buffer.slice(newline + 1);
          newline = this.#buffer.indexOf('\n');
          try { this.#handle(JSON.parse(line) as Record<string, unknown>); } catch (error) { this.#fail(error); return; }
        }
        if (!snapshot.running) { this.#fail(new Error('Codebase Memory frontend exited')); return; }
      }
    } catch (error) {
      this.#fail(error);
    }
  }

  async #readStderr(): Promise<void> {
    try {
      while (this.isUsable) {
        const snapshot = await this.process.readStderr(this.#stderrOffset, { waitMs: 1_000, maxBytes: MAX_OUTPUT_BYTES });
        this.#stderrOffset = snapshot.nextOffset;
        this.#stderr += this.#stderrDecoder.decode(snapshot.output, { stream: snapshot.running });
        if (Buffer.byteLength(this.#stderr) > MAX_OUTPUT_BYTES) this.#stderr = this.#stderr.slice(-MAX_OUTPUT_BYTES);
        if (!snapshot.running) return;
      }
    } catch (error) {
      this.#fail(error);
    }
  }

  #handle(message: Record<string, unknown>): void {
    const id = message.id;
    if (id === undefined && typeof message.method === 'string') return;
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) throw new Error('Codebase Memory returned an invalid JSON-RPC response');
    const pending = this.#pending.get(id);
    if (!pending) throw new Error(`Codebase Memory returned an unknown response id: ${id}`);
    this.#pending.delete(id);
    if (message.error && typeof message.error === 'object') {
      pending.reject(new Error(sanitize(JSON.stringify(message.error))));
      return;
    }
    const result = asRecord(message.result);
    const text = result.content instanceof Array
      ? result.content.find((block) => asRecord(block).type === 'text' && typeof asRecord(block).text === 'string')
      : undefined;
    const textValue = asRecord(text).text;
    const value = typeof textValue === 'string' ? textValue : JSON.stringify(result) ?? '{}';
    let data: unknown = value;
    try { data = JSON.parse(value); } catch { /* Preserve non-JSON upstream text. */ }
    if (result.isError) {
      pending.reject(new Error(sanitize(typeof data === 'string' ? data : JSON.stringify(data))));
      return;
    }
    pending.resolve({ data, stderr: sanitize(this.#stderr) });
  }

  #fail(reason: unknown): void {
    if (!this.isUsable) return;
    this.#usable = false;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    void this.process.dispose().catch(() => {});
  }
}

async function waitForProcess(process: AgentRuntimeStdioProcess, timeoutMs: number): Promise<void> {
  const started = Date.now();
  let offset = 0;
  while (Date.now() - started < timeoutMs) {
    const snapshot = await process.readStdout(offset, { waitMs: Math.min(50, timeoutMs), maxBytes: 1 });
    offset = snapshot.nextOffset;
    if (!snapshot.running) return;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
