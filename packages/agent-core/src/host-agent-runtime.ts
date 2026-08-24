import { spawn, type ChildProcess } from 'node:child_process';
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { IDisposable, IPty } from '@lydell/node-pty';
import type {
  AgentRuntime,
  AgentRuntimeExecOptions,
  AgentRuntimeFileReadOptions,
  AgentRuntimeFileWriteOptions,
  AgentRuntimeListFilesOptions,
  AgentRuntimeProcess,
  AgentRuntimeProcesses,
  AgentRuntimeProcessReadOptions,
  AgentRuntimeProcessSnapshot,
  AgentRuntimeShellProcessOptions,
  AgentRuntimeStorage,
  AgentRuntimeStorageScope,
  AgentRuntimeTerminals,
  ExecResult,
} from './runtime.js';
import { fileListingGlobMatcher, normalizeFileListingPath } from './file-listing.js';

export type HostShellOptions = AgentRuntimeExecOptions & {
  env?: Readonly<Record<string, string>>;
};

export interface HostAgentRuntimeOptions {
  readonly sessionStorageRoot: string;
  readonly agentStorageRoot: string;
  readonly agentDir?: string;
  readonly pathAccess?: 'workspace' | 'host';
}

export class HostAgentRuntime implements AgentRuntime {
  readonly #cwd: string;
  readonly #sessionStorage: AgentRuntimeStorage;
  readonly #agentStorage: AgentRuntimeStorage;
  readonly #sessionStorageRoot: string;
  readonly #agentStorageRoot: string;
  readonly #agentDir: string | undefined;
  readonly #pathAccess: 'workspace' | 'host';
  readonly processes: AgentRuntimeProcesses;
  readonly terminals: AgentRuntimeTerminals;

  constructor(cwd: string, options: HostAgentRuntimeOptions) {
    if (cwd.includes('\0')) {
      throw new Error('Runtime cwd cannot contain NUL bytes');
    }
    this.#cwd = resolve(cwd);
    this.#sessionStorageRoot = resolveStorageRoot(options.sessionStorageRoot);
    this.#agentStorageRoot = resolveStorageRoot(options.agentStorageRoot);
    this.#agentDir = options.agentDir === undefined ? undefined : resolveStorageRoot(options.agentDir);
    this.#pathAccess = options.pathAccess ?? 'workspace';
    this.#sessionStorage = createHostStorage(this.#sessionStorageRoot);
    this.#agentStorage = createHostStorage(this.#agentStorageRoot);
    this.processes = {
      startShell: async (command, processOptions) => this.#startShellProcess(command, processOptions),
    };
    this.terminals = {
      startShell: async (command, terminalOptions) => this.#startShellTerminal(command, terminalOptions),
    };
  }

  get kind(): 'host' {
    return 'host';
  }

  get cwd(): string {
    return this.#cwd;
  }

  storage(scope: AgentRuntimeStorageScope = 'session'): AgentRuntimeStorage {
    if (scope === 'session') return this.#sessionStorage;
    if (scope === 'agent') return this.#agentStorage;
    throw new Error(`Unsupported runtime storage scope: ${String(scope)}`);
  }

  async exec(
    command: string,
    args: readonly string[],
    options?: AgentRuntimeExecOptions,
  ): Promise<ExecResult> {
    const literalArgs = [...args];
    const cwd = await this.#resolvePath(options?.cwd ?? this.#cwd);
    return this.#spawn(command, literalArgs, cwd, options, false);
  }

  async shell(command: string, options?: HostShellOptions): Promise<ExecResult> {
    const env = options?.env ? { ...options.env } : undefined;
    const cwd = await this.#resolvePath(options?.cwd ?? this.#cwd);
    return this.#spawn(command, [], cwd, options, true, env);
  }

  async readFile(path: string, options?: AgentRuntimeFileReadOptions): Promise<Uint8Array> {
    const resolvedPath = this.#pathAccess === 'host'
      ? resolveHostPath(this.#cwd, path)
      : await resolveReadablePath(
          this.#cwd,
          this.#sessionStorageRoot,
          this.#agentStorageRoot,
          path,
        );
    const content = options?.maxBytes === undefined
      ? await readFile(resolvedPath)
      : await readBoundedFile(resolvedPath, options.maxBytes);
    return new Uint8Array(content);
  }

  async writeFile(
    path: string,
    content: Uint8Array,
    options?: AgentRuntimeFileWriteOptions,
  ): Promise<void> {
    const copiedContent = content.slice();
    const resolvedPath = await this.#resolvePath(path);
    await writeFile(resolvedPath, copiedContent, options?.exclusive ? { flag: 'wx' } : undefined);
  }

  async listFiles(path: string, options?: AgentRuntimeListFilesOptions): Promise<string[]> {
    const resolvedPath = this.#pathAccess === 'host'
      ? resolveHostPath(this.#cwd, path)
      : await resolveReadablePath(
          this.#cwd,
          this.#sessionStorageRoot,
          this.#agentStorageRoot,
          path,
        );
    return listHostFiles(resolvedPath, options);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const resolvedPath = await this.#resolvePath(path);
    await mkdir(resolvedPath, { recursive: options?.recursive ?? false });
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    const resolvedPath = await this.#resolvePath(path, false);
    await rm(resolvedPath, { recursive: options?.recursive ?? false });
  }

  async readAgentFile(path: string): Promise<Uint8Array> {
    if (!this.#agentDir) {
      throw Object.assign(new Error('Runtime agent directory is unavailable'), { code: 'ENOENT' });
    }
    const content = await readFile(await resolveContainedPath(this.#agentDir, path));
    return new Uint8Array(content);
  }

  async #startShellProcess(
    command: string,
    options?: AgentRuntimeShellProcessOptions,
  ): Promise<AgentRuntimeProcess> {
    const cwd = await this.#resolvePath(options?.cwd ?? this.#cwd);
    const shell = options?.shell ?? defaultShell();
    const args = shellArguments(shell, command, options?.login ?? true);
    const child = spawn(shell, args, {
      cwd,
      detached: process.platform !== 'win32',
      env: options?.env ? { ...process.env, ...options.env } : process.env,
      stdio: [options?.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return new HostRuntimeProcess(child);
  }

  async #startShellTerminal(
    command: string,
    options?: AgentRuntimeShellProcessOptions,
  ): Promise<AgentRuntimeProcess> {
    const cwd = await this.#resolvePath(options?.cwd ?? this.#cwd);
    const shell = options?.shell ?? defaultShell();
    const args = shellArguments(shell, command, options?.login ?? true);
    const env = terminalEnvironment(options?.env);
    const pty = await loadPty();
    const terminal = pty.spawn(shell, args, {
      cwd,
      env,
      name: env.TERM ?? 'xterm-256color',
      cols: 80,
      rows: 24,
      encoding: null,
    });
    return new HostRuntimeTerminal(terminal);
  }

  async #resolvePath(path: string, allowRoot = true): Promise<string> {
    return this.#pathAccess === 'host'
      ? resolveHostPath(this.#cwd, path)
      : resolveContainedPath(this.#cwd, path, allowRoot);
  }

  async #spawn(
    command: string,
    args: string[],
    cwd: string,
    options: AgentRuntimeExecOptions | undefined,
    shell: boolean,
    env?: Readonly<Record<string, string>>,
  ): Promise<ExecResult> {
    if (options?.signal?.aborted) {
      return killedResult();
    }
    const maxOutputBytes = validateMaxOutputBytes(options?.maxOutputBytes);

    return new Promise((resolveResult) => {
      const child = spawn(command, args, {
        cwd,
        detached: process.platform !== 'win32',
        env: env ? { ...process.env, ...env } : process.env,
        shell,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stdout: Uint8Array[] = [];
      const stderr: Uint8Array[] = [];
      let capturedOutputBytes = 0;
      let outputTruncated = false;
      let killed = false;
      let spawnError: Error | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;

      const kill = (): void => {
        if (killed) return;
        killed = true;
        killChild(child, 'SIGTERM');
        forceKillTimeout = setTimeout(() => killChild(child, 'SIGKILL'), 1_000);
        forceKillTimeout.unref();
      };

      const finish = (code: number | null): void => {
        if (timeout) clearTimeout(timeout);
        if (killed) killChild(child, 'SIGKILL');
        if (forceKillTimeout) clearTimeout(forceKillTimeout);
        options?.signal?.removeEventListener('abort', kill);
        resolveResult({
          stdout: Buffer.concat(stdout).toString(),
          stderr: spawnError?.message ?? Buffer.concat(stderr).toString(),
          code: killed ? 143 : (code ?? (spawnError ? 1 : 0)),
          killed,
          ...(outputTruncated ? { truncated: true } : {}),
        });
      };

      child.stdout.on('data', (chunk: Uint8Array) => {
        const captured = captureOutputChunk(chunk, maxOutputBytes, capturedOutputBytes);
        capturedOutputBytes = captured.nextBytes;
        outputTruncated ||= captured.truncated;
        if (captured.chunk.length > 0) stdout.push(captured.chunk);
      });
      child.stderr.on('data', (chunk: Uint8Array) => {
        const captured = captureOutputChunk(chunk, maxOutputBytes, capturedOutputBytes);
        capturedOutputBytes = captured.nextBytes;
        outputTruncated ||= captured.truncated;
        if (captured.chunk.length > 0) stderr.push(captured.chunk);
      });
      child.once('error', (error) => {
        spawnError = error;
      });
      child.once('close', finish);

      if (options?.signal) {
        options.signal.addEventListener('abort', kill, { once: true });
        if (options.signal.aborted) kill();
      }
      if (options?.timeout && options.timeout > 0) {
        timeout = setTimeout(kill, options.timeout);
        timeout.unref();
      }
    });
  }
}

const MAX_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;

abstract class HostBufferedProcess implements AgentRuntimeProcess {
  readonly #output = new HostProcessOutput();
  #disposed = false;
  #termination: Promise<void> | undefined;

  abstract get pid(): number | undefined;

  abstract write(content: Uint8Array): Promise<void>;

  read(
    afterOffset: number,
    options?: AgentRuntimeProcessReadOptions,
  ): Promise<AgentRuntimeProcessSnapshot> {
    return this.#output.read(afterOffset, options);
  }

  async interrupt(): Promise<void> {
    if (!this.#output.running) return;
    await this.sendSignal('SIGINT');
  }

  terminate(): Promise<void> {
    this.#termination ??= this.#terminate();
    return this.#termination;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      await this.terminate();
    } finally {
      this.#output.dispose();
      this.onDispose();
    }
  }

  protected get running(): boolean {
    return this.#output.running;
  }

  protected appendOutput(chunk: Uint8Array): void {
    this.#output.append(chunk);
  }

  protected complete(exitCode: number): void {
    this.#output.complete(exitCode);
  }

  protected abstract sendSignal(signal: NodeJS.Signals): void | Promise<void>;

  protected onDispose(): void {}

  async #terminate(): Promise<void> {
    if (!this.#output.running) return;
    try {
      await this.sendSignal('SIGTERM');
    } catch (error) {
      if (this.#output.running) throw error;
    }
    const deadline = Date.now() + 1_000;
    while (this.#output.running && Date.now() < deadline) {
      await this.#output.wait(Math.min(50, deadline - Date.now()));
    }
    if (!this.#output.running) return;
    try {
      await this.sendSignal('SIGKILL');
    } catch (error) {
      if (this.#output.running) throw error;
    }
    const forceDeadline = Date.now() + 1_000;
    while (this.#output.running && Date.now() < forceDeadline) {
      await this.#output.wait(Math.min(50, forceDeadline - Date.now()));
    }
  }
}

class HostRuntimeProcess extends HostBufferedProcess {
  readonly #child: ChildProcess;

  constructor(child: ChildProcess) {
    super();
    this.#child = child;
    child.stdout?.on('data', (chunk: Uint8Array) => this.appendOutput(chunk));
    child.stderr?.on('data', (chunk: Uint8Array) => this.appendOutput(chunk));
    child.once('error', (error) => this.appendOutput(Buffer.from(`${error.message}\n`)));
    child.once('close', (code, signal) => {
      this.complete(code ?? signalExitCode(signal));
    });
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  async write(content: Uint8Array): Promise<void> {
    if (!this.running) throw new Error('Process has exited');
    if (!this.#child.stdin) throw new Error('Process stdin is closed');
    await new Promise<void>((resolveWrite, rejectWrite) => {
      this.#child.stdin!.write(content, (error) => {
        if (error) rejectWrite(error);
        else resolveWrite();
      });
    });
  }

  protected sendSignal(signal: NodeJS.Signals): void {
    if (signal === 'SIGINT' && process.platform === 'win32') {
      killChild(this.#child, 'SIGTERM');
      return;
    }
    killChild(this.#child, signal);
  }
}

class HostRuntimeTerminal extends HostBufferedProcess {
  readonly #terminal: IPty;
  readonly #dataSubscription: IDisposable;
  readonly #exitSubscription: IDisposable;

  constructor(terminal: IPty) {
    super();
    this.#terminal = terminal;
    this.#dataSubscription = terminal.onData((data) => {
      const raw = data as unknown;
      this.appendOutput(typeof raw === 'string' ? Buffer.from(raw) : new Uint8Array(raw as Buffer));
    });
    this.#exitSubscription = terminal.onExit(({ exitCode, signal }) => {
      this.complete(signal ? 128 + signal : exitCode);
    });
  }

  get pid(): number {
    return this.#terminal.pid;
  }

  async write(content: Uint8Array): Promise<void> {
    if (!this.running) throw new Error('Process has exited');
    this.#terminal.write(Buffer.from(content));
  }

  protected sendSignal(signal: NodeJS.Signals): void {
    if (process.platform === 'win32') {
      if (signal === 'SIGINT') this.#terminal.write('\u0003');
      else this.#terminal.kill();
      return;
    }
    try {
      process.kill(-this.#terminal.pid, signal);
    } catch (error) {
      if (!isNoSuchProcessError(error) && !isPermissionError(error)) throw error;
      if (this.running) this.#terminal.kill(signal);
    }
  }

  protected override onDispose(): void {
    this.#dataSubscription.dispose();
    this.#exitSubscription.dispose();
  }
}

class HostProcessOutput {
  readonly #listeners = new Set<() => void>();
  #buffer = Buffer.alloc(0);
  #bufferStartOffset = 0;
  #running = true;
  #exitCode: number | undefined;

  get running(): boolean {
    return this.#running;
  }

  async read(
    afterOffset: number,
    options?: AgentRuntimeProcessReadOptions,
  ): Promise<AgentRuntimeProcessSnapshot> {
    const hasOutput = afterOffset < this.#bufferStartOffset + this.#buffer.length;
    if (!hasOutput && this.#running && (options?.waitMs ?? 0) > 0) {
      await this.wait(options!.waitMs!, options?.signal);
    }
    const bufferEndOffset = this.#bufferStartOffset + this.#buffer.length;
    const boundedAfter = Math.max(afterOffset, this.#bufferStartOffset);
    let output = this.#buffer.subarray(boundedAfter - this.#bufferStartOffset);
    if (options?.maxBytes !== undefined && output.length > options.maxBytes) {
      output = output.subarray(output.length - options.maxBytes);
    }
    return {
      output: new Uint8Array(output),
      nextOffset: bufferEndOffset,
      running: this.#running,
      ...(this.#exitCode === undefined ? {} : { exitCode: this.#exitCode }),
    };
  }

  append(chunk: Uint8Array): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > MAX_PROCESS_OUTPUT_BYTES) {
      const removed = this.#buffer.length - MAX_PROCESS_OUTPUT_BYTES;
      this.#buffer = this.#buffer.subarray(removed);
      this.#bufferStartOffset += removed;
    }
    this.#notify();
  }

  complete(exitCode: number): void {
    if (!this.#running) return;
    this.#running = false;
    this.#exitCode = exitCode;
    this.#notify();
  }

  dispose(): void {
    this.#listeners.clear();
  }

  wait(waitMs: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted || !this.#running) return Promise.resolve(!this.#running);
    return new Promise((resolveWait) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', finish);
        this.#listeners.delete(finish);
        resolveWait(!this.#running);
      };
      const timeout = setTimeout(finish, waitMs);
      timeout.unref?.();
      this.#listeners.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

function createHostStorage(root: string): AgentRuntimeStorage {
  return {
    root,
    async readFile(path) {
      const content = await readFile(await resolveContainedPath(root, path));
      return new Uint8Array(content);
    },
    async writeFile(path, content) {
      const copiedContent = content.slice();
      await writeFile(await resolveContainedPath(root, path), copiedContent);
    },
    async listFiles(path, options) {
      const resolvedPath = await resolveContainedPath(root, path);
      return listHostFiles(resolvedPath, options);
    },
    async mkdir(path, options) {
      await mkdir(await resolveContainedPath(root, path), {
        recursive: options?.recursive ?? false,
      });
    },
    async remove(path, options) {
      await rm(await resolveContainedPath(root, path, false), {
        recursive: options?.recursive ?? false,
      });
    },
  };
}

async function listHostFiles(
  root: string,
  options: AgentRuntimeListFilesOptions = {},
): Promise<string[]> {
  throwIfListingAborted(options.signal);
  const recursive = options.recursive ?? false;
  const maximumDepth = validateListingBound(
    'maxDepth',
    options.maxDepth,
    recursive ? Number.MAX_SAFE_INTEGER : 1,
  );
  const limit = validateListingBound('limit', options.limit, Number.MAX_SAFE_INTEGER);
  if (maximumDepth === 0 || limit === 0) {
    throwIfListingAborted(options.signal);
    const directory = await opendir(root);
    await directory.close();
    return [];
  }

  if (options.pattern !== undefined && typeof options.pattern !== 'string') {
    throw new Error('pattern must be a string');
  }
  const matcher = options.pattern === undefined
    ? undefined
    : fileListingGlobMatcher(options.pattern);
  const ignoreMatchers = (options.ignore ?? []).map((pattern) => {
    if (typeof pattern !== 'string') throw new Error('ignore patterns must be strings');
    return fileListingGlobMatcher(pattern);
  });

  const candidates = limit === Number.MAX_SAFE_INTEGER
    ? undefined
    : new BoundedPathHeap(limit);
  const unboundedResults: string[] = [];
  const addResult = (path: string): void => {
    if (candidates) candidates.push(path);
    else unboundedResults.push(path);
  };

  const visitDirectory = async (relativeDirectory = '', depth = 0): Promise<void> => {
    throwIfListingAborted(options.signal);
    const absoluteDirectory = relativeDirectory ? join(root, relativeDirectory) : root;
    if (relativeDirectory) {
      const stats = await lstat(absoluteDirectory);
      if (!stats.isDirectory()) return;
    }
    const directory = await opendir(absoluteDirectory);
    for await (const entry of directory) {
      throwIfListingAborted(options.signal);
      if (!entry.isDirectory() && !entry.isFile()) continue;
      const relativePath = relativeDirectory
        ? join(relativeDirectory, entry.name)
        : entry.name;
      const normalizedPath = normalizeFileListingPath(relativePath);
      const entryDepth = depth + 1;
      if (isIgnoredListingPath(normalizedPath, entry.isDirectory(), ignoreMatchers)) continue;

      if (entry.isDirectory()) {
        const canReturn = options.includeDirectories === true
          && (matcher?.test(normalizedPath) ?? true);
        if (canReturn) addResult(relativePath);
        const canDescend = recursive && entryDepth < maximumDepth;
        if (canDescend) await visitDirectory(relativePath, entryDepth);
      } else if (matcher?.test(normalizedPath) ?? true) {
        addResult(relativePath);
      }
    }
  };

  await visitDirectory();
  const results = candidates?.values() ?? unboundedResults;
  results.sort();
  return results;
}

function validateListingBound(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return resolved;
}

function throwIfListingAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Operation aborted');
}

function isIgnoredListingPath(
  path: string,
  directory: boolean,
  matchers: readonly RegExp[],
): boolean {
  return matchers.some((matcher) => (
    matcher.test(path) || (directory && matcher.test(`${path}/`))
  ));
}

class BoundedPathHeap {
  readonly #entries: string[] = [];

  constructor(private readonly limit: number) {}

  push(entry: string): void {
    if (this.#entries.length >= this.limit) {
      if (entry >= this.#entries[0]!) return;
      this.#entries[0] = entry;
      this.#siftDown(0);
      return;
    }
    let index = this.#entries.push(entry) - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.#entries[parent]! >= entry) break;
      this.#entries[index] = this.#entries[parent]!;
      index = parent;
    }
    this.#entries[index] = entry;
  }

  values(): string[] {
    return [...this.#entries];
  }

  #siftDown(index: number): void {
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.#entries.length) return;
      const right = left + 1;
      const child = right < this.#entries.length && this.#entries[right]! > this.#entries[left]!
        ? right
        : left;
      if (this.#entries[index]! >= this.#entries[child]!) return;
      [this.#entries[index], this.#entries[child]] = [this.#entries[child]!, this.#entries[index]!];
      index = child;
    }
  }
}

let ptyModule: Promise<typeof import('@lydell/node-pty')> | undefined;

function loadPty(): Promise<typeof import('@lydell/node-pty')> {
  ptyModule ??= import('@lydell/node-pty');
  return ptyModule;
}

function terminalEnvironment(overrides?: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...overrides };
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec ?? 'cmd.exe';
  return process.env.SHELL ?? '/bin/sh';
}

function shellArguments(shell: string, command: string, login: boolean): string[] {
  if (process.platform === 'win32' && /(?:^|[\\/])cmd(?:\.exe)?$/iu.test(shell)) {
    return ['/d', '/s', '/c', command];
  }
  return login ? ['-l', '-c', command] : ['-c', command];
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  return 128 + (osConstants.signals[signal] ?? 15);
}

function resolveStorageRoot(root: string): string {
  if (root.includes('\0')) throw new Error('Runtime storage root cannot contain NUL bytes');
  return resolve(root);
}

function resolveHostPath(cwd: string, path: string): string {
  if (path.includes('\0')) throw new Error('Paths cannot contain NUL bytes');
  return resolve(cwd, path);
}

async function resolveReadablePath(
  cwd: string,
  sessionStorageRoot: string,
  agentStorageRoot: string,
  path: string,
): Promise<string> {
  if (path.includes('\0')) throw new Error('Paths cannot contain NUL bytes');
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  if (isContained(agentStorageRoot, resolvedPath)) {
    throw new Error(`Path is inside agent storage: ${resolvedPath}`);
  }
  if (isContained(cwd, resolvedPath)) {
    return resolveContainedPath(cwd, resolvedPath, true, agentStorageRoot);
  }
  if (isContained(sessionStorageRoot, resolvedPath)) {
    return resolveContainedPath(sessionStorageRoot, resolvedPath, true, agentStorageRoot);
  }
  throw new Error(`Path escapes runtime root: ${resolvedPath}`);
}

async function resolveContainedPath(
  root: string,
  path: string,
  allowRoot = true,
  excludedRoot?: string,
): Promise<string> {
  if (path.includes('\0')) throw new Error('Paths cannot contain NUL bytes');

  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(root, path);
  assertContained(root, resolvedPath, allowRoot);
  if (excludedRoot && isContained(excludedRoot, resolvedPath)) {
    throw new Error(`Path is inside agent storage: ${resolvedPath}`);
  }

  const resolvedRoot = await realpath(root);
  const resolvedExcludedRoot = excludedRoot === undefined ? undefined : await realpath(excludedRoot);
  const segments = relative(root, resolvedPath).split(sep).filter(Boolean);
  let current = resolvedRoot;

  for (let index = 0; index < segments.length; index += 1) {
    const candidate = join(current, segments[index]!);
    try {
      const stats = await lstat(candidate);
      if (stats.isSymbolicLink()) {
        const target = await readlink(candidate);
        const resolvedTarget = resolve(current, target);
        assertContained(resolvedRoot, resolvedTarget, allowRoot);
        try {
          current = await realpath(candidate);
        } catch (error) {
          if (!isMissingPathError(error)) throw error;
          current = resolvedTarget;
        }
        assertContained(resolvedRoot, current, allowRoot);
        if (resolvedExcludedRoot && isContained(resolvedExcludedRoot, current)) {
          throw new Error(`Path is inside agent storage: ${current}`);
        }
      } else {
        current = candidate;
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      current = resolve(current, ...segments.slice(index));
      assertContained(resolvedRoot, current, allowRoot);
      break;
    }
  }

  assertContained(resolvedRoot, current, allowRoot);
  if (resolvedExcludedRoot && isContained(resolvedExcludedRoot, current)) {
    throw new Error(`Path is inside agent storage: ${current}`);
  }
  return resolvedPath;
}

function assertContained(root: string, path: string, allowRoot: boolean): void {
  const relativePath = relative(root, path);
  if (!isContained(root, path)) throw new Error(`Path escapes runtime root: ${path}`);
  if (!allowRoot && relativePath === '') throw new Error('The runtime root cannot be removed');
}

function isContained(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function killChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.unref();
    return;
  }

  try {
    process.kill(-child.pid, signal);
    return;
  } catch (error) {
    if (!isNoSuchProcessError(error) && !isPermissionError(error)) throw error;
  }

  try {
    child.kill(signal);
  } catch (error) {
    if (!isNoSuchProcessError(error) && !isPermissionError(error)) throw error;
  }
}

function isNoSuchProcessError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

function isPermissionError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EPERM';
}

function killedResult(): ExecResult {
  return { stdout: '', stderr: '', code: 143, killed: true };
}

function validateMaxOutputBytes(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('maxOutputBytes must be a non-negative safe integer');
  }
  return value;
}

function captureOutputChunk(
  chunk: Uint8Array,
  maximum: number | undefined,
  captured: number,
): { readonly chunk: Uint8Array; readonly nextBytes: number; readonly truncated: boolean } {
  if (maximum === undefined) {
    return { chunk, nextBytes: captured + chunk.byteLength, truncated: false };
  }
  const remaining = Math.max(0, maximum - captured);
  const retained = chunk.subarray(0, Math.min(remaining, chunk.byteLength));
  return {
    chunk: retained,
    nextBytes: captured + retained.byteLength,
    truncated: retained.byteLength < chunk.byteLength,
  };
}

async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error('maxBytes must be a non-negative safe integer');
  }
  const handle = await open(path, 'r');
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) return Buffer.concat(chunks, total);
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    throw new Error(`File exceeds maximum size of ${maxBytes} bytes`);
  } finally {
    await handle.close();
  }
}
