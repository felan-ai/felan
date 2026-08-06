import { spawn, type ChildProcess } from 'node:child_process';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  AgentRuntime,
  AgentRuntimeFileReadOptions,
  AgentRuntimeFileWriteOptions,
  AgentRuntimeProcess,
  AgentRuntimeProcesses,
  AgentRuntimeProcessReadOptions,
  AgentRuntimeProcessSnapshot,
  AgentRuntimeShellProcessOptions,
  AgentRuntimeStorage,
  AgentRuntimeStorageScope,
  ExecOptions,
  ExecResult,
} from './runtime.js';

export type HostShellOptions = ExecOptions & {
  env?: Readonly<Record<string, string>>;
};

export interface HostAgentRuntimeOptions {
  readonly sessionStorageRoot: string;
  readonly agentStorageRoot: string;
  readonly agentDir?: string;
}

export class HostAgentRuntime implements AgentRuntime {
  readonly #cwd: string;
  readonly #sessionStorage: AgentRuntimeStorage;
  readonly #agentStorage: AgentRuntimeStorage;
  readonly #sessionStorageRoot: string;
  readonly #agentStorageRoot: string;
  readonly #agentDir: string | undefined;
  readonly processes: AgentRuntimeProcesses;

  constructor(cwd: string, options: HostAgentRuntimeOptions) {
    if (cwd.includes('\0')) {
      throw new Error('Runtime cwd cannot contain NUL bytes');
    }
    this.#cwd = resolve(cwd);
    this.#sessionStorageRoot = resolveStorageRoot(options.sessionStorageRoot);
    this.#agentStorageRoot = resolveStorageRoot(options.agentStorageRoot);
    this.#agentDir = options.agentDir === undefined ? undefined : resolveStorageRoot(options.agentDir);
    this.#sessionStorage = createHostStorage(this.#sessionStorageRoot);
    this.#agentStorage = createHostStorage(this.#agentStorageRoot);
    this.processes = {
      startShell: async (command, processOptions) => this.#startShellProcess(command, processOptions),
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
    options?: ExecOptions,
  ): Promise<ExecResult> {
    const literalArgs = [...args];
    const cwd = await resolveContainedPath(this.#cwd, options?.cwd ?? this.#cwd);
    return this.#spawn(command, literalArgs, cwd, options, false);
  }

  async shell(command: string, options?: HostShellOptions): Promise<ExecResult> {
    const env = options?.env ? { ...options.env } : undefined;
    const cwd = await resolveContainedPath(this.#cwd, options?.cwd ?? this.#cwd);
    return this.#spawn(command, [], cwd, options, true, env);
  }

  async readFile(path: string, options?: AgentRuntimeFileReadOptions): Promise<Uint8Array> {
    const resolvedPath = await resolveReadablePath(
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
    const resolvedPath = await resolveContainedPath(this.#cwd, path);
    await writeFile(resolvedPath, copiedContent, options?.exclusive ? { flag: 'wx' } : undefined);
  }

  async listFiles(path: string, options?: { recursive?: boolean }): Promise<string[]> {
    const resolvedPath = await resolveReadablePath(
      this.#cwd,
      this.#sessionStorageRoot,
      this.#agentStorageRoot,
      path,
    );
    const entries = await readdir(resolvedPath, {
      recursive: options?.recursive ?? false,
      withFileTypes: true,
    });

    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(resolvedPath, resolve(entry.parentPath, entry.name)))
      .sort();
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const resolvedPath = await resolveContainedPath(this.#cwd, path);
    await mkdir(resolvedPath, { recursive: options?.recursive ?? false });
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    const resolvedPath = await resolveContainedPath(this.#cwd, path, false);
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
    const cwd = await resolveContainedPath(this.#cwd, options?.cwd ?? this.#cwd);
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

  async #spawn(
    command: string,
    args: string[],
    cwd: string,
    options: ExecOptions | undefined,
    shell: boolean,
    env?: Readonly<Record<string, string>>,
  ): Promise<ExecResult> {
    if (options?.signal?.aborted) {
      return killedResult();
    }

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
        });
      };

      child.stdout.on('data', (chunk: Uint8Array) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Uint8Array) => stderr.push(chunk));
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

class HostRuntimeProcess implements AgentRuntimeProcess {
  readonly #child: ChildProcess;
  readonly #listeners = new Set<() => void>();
  #buffer = Buffer.alloc(0);
  #bufferStartOffset = 0;
  #running = true;
  #exitCode: number | undefined;
  #disposed = false;
  #termination: Promise<void> | undefined;

  constructor(child: ChildProcess) {
    this.#child = child;
    child.stdout?.on('data', (chunk: Uint8Array) => this.#append(chunk));
    child.stderr?.on('data', (chunk: Uint8Array) => this.#append(chunk));
    child.once('error', (error) => this.#append(Buffer.from(`${error.message}\n`)));
    child.once('close', (code, signal) => {
      this.#running = false;
      this.#exitCode = code ?? signalExitCode(signal);
      this.#notify();
    });
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  async read(
    afterOffset: number,
    options?: AgentRuntimeProcessReadOptions,
  ): Promise<AgentRuntimeProcessSnapshot> {
    const hasOutput = afterOffset < this.#bufferStartOffset + this.#buffer.length;
    if (!hasOutput && this.#running && (options?.waitMs ?? 0) > 0) {
      await this.#wait(options!.waitMs!, options?.signal);
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

  async write(content: Uint8Array): Promise<void> {
    if (!this.#running) throw new Error('Process has exited');
    if (!this.#child.stdin) throw new Error('Process stdin is closed');
    await new Promise<void>((resolveWrite, rejectWrite) => {
      this.#child.stdin!.write(content, (error) => {
        if (error) rejectWrite(error);
        else resolveWrite();
      });
    });
  }

  terminate(): Promise<void> {
    this.#termination ??= this.#terminate();
    return this.#termination;
  }

  async #terminate(): Promise<void> {
    if (!this.#running) return;
    killChild(this.#child, 'SIGTERM');
    const deadline = Date.now() + 1_000;
    while (this.#running && Date.now() < deadline) {
      await this.#wait(Math.min(50, deadline - Date.now()));
    }
    if (this.#running) {
      killChild(this.#child, 'SIGKILL');
      const forceDeadline = Date.now() + 1_000;
      while (this.#running && Date.now() < forceDeadline) {
        await this.#wait(Math.min(50, forceDeadline - Date.now()));
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.terminate();
    this.#listeners.clear();
  }

  #append(chunk: Uint8Array): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > MAX_PROCESS_OUTPUT_BYTES) {
      const removed = this.#buffer.length - MAX_PROCESS_OUTPUT_BYTES;
      this.#buffer = this.#buffer.subarray(removed);
      this.#bufferStartOffset += removed;
    }
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  #wait(waitMs: number, signal?: AbortSignal): Promise<boolean> {
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
      const entries = await readdir(resolvedPath, {
        recursive: options?.recursive ?? false,
        withFileTypes: true,
      });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => relative(resolvedPath, resolve(entry.parentPath, entry.name)))
        .sort();
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
  if (signal === 'SIGKILL') return 137;
  if (signal === 'SIGINT') return 130;
  return signal ? 143 : 1;
}

function resolveStorageRoot(root: string): string {
  if (root.includes('\0')) throw new Error('Runtime storage root cannot contain NUL bytes');
  return resolve(root);
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
    if (!isNoSuchProcessError(error)) throw error;
  }

  child.kill(signal);
}

function isNoSuchProcessError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

function killedResult(): ExecResult {
  return { stdout: '', stderr: '', code: 143, killed: true };
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
