import { spawn, type ChildProcess } from 'node:child_process';
import {
  lstat,
  mkdir,
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
}

export class HostAgentRuntime implements AgentRuntime {
  readonly #cwd: string;
  readonly #sessionStorage: AgentRuntimeStorage;
  readonly #agentStorage: AgentRuntimeStorage;
  readonly #sessionStorageRoot: string;
  readonly #agentStorageRoot: string;

  constructor(cwd: string, options: HostAgentRuntimeOptions) {
    if (cwd.includes('\0')) {
      throw new Error('Runtime cwd cannot contain NUL bytes');
    }
    this.#cwd = resolve(cwd);
    this.#sessionStorageRoot = resolveStorageRoot(options.sessionStorageRoot);
    this.#agentStorageRoot = resolveStorageRoot(options.agentStorageRoot);
    this.#sessionStorage = createHostStorage(this.#sessionStorageRoot);
    this.#agentStorage = createHostStorage(this.#agentStorageRoot);
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

  async readFile(path: string): Promise<Uint8Array> {
    const resolvedPath = await resolveReadablePath(
      this.#cwd,
      this.#sessionStorageRoot,
      this.#agentStorageRoot,
      path,
    );
    const content = await readFile(resolvedPath);
    return new Uint8Array(content);
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    const copiedContent = content.slice();
    const resolvedPath = await resolveContainedPath(this.#cwd, path);
    await writeFile(resolvedPath, copiedContent);
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
