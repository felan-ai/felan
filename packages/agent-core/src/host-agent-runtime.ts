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
  ExecOptions,
  ExecResult,
} from './runtime.js';

export type HostShellOptions = ExecOptions & {
  env?: Readonly<Record<string, string>>;
};

export interface HostAgentRuntimeOptions {
  readonly storageRoot?: string;
}

export class HostAgentRuntime implements AgentRuntime {
  readonly #cwd: string;
  readonly #storage: AgentRuntimeStorage;

  constructor(cwd = process.cwd(), options: HostAgentRuntimeOptions = {}) {
    if (cwd.includes('\0')) {
      throw new Error('Runtime cwd cannot contain NUL bytes');
    }
    this.#cwd = resolve(cwd);
    this.#storage = createHostStorage(options.storageRoot ?? this.#cwd);
  }

  get kind(): 'host' {
    return 'host';
  }

  get cwd(): string {
    return this.#cwd;
  }

  get storage(): AgentRuntimeStorage {
    return this.#storage;
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
    const resolvedPath = await resolveContainedPath(this.#cwd, path);
    const content = await readFile(resolvedPath);
    return new Uint8Array(content);
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    const copiedContent = content.slice();
    const resolvedPath = await resolveContainedPath(this.#cwd, path);
    await writeFile(resolvedPath, copiedContent);
  }

  async listFiles(path: string, options?: { recursive?: boolean }): Promise<string[]> {
    const resolvedPath = await resolveContainedPath(this.#cwd, path);
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
  if (root.includes('\0')) throw new Error('Runtime storage root cannot contain NUL bytes');
  const storageRoot = resolve(root);
  return {
    root: storageRoot,
    async readFile(path) {
      const content = await readFile(await resolveContainedPath(storageRoot, path));
      return new Uint8Array(content);
    },
    async writeFile(path, content) {
      const copiedContent = content.slice();
      await writeFile(await resolveContainedPath(storageRoot, path), copiedContent);
    },
    async listFiles(path, options) {
      const resolvedPath = await resolveContainedPath(storageRoot, path);
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
      await mkdir(await resolveContainedPath(storageRoot, path), {
        recursive: options?.recursive ?? false,
      });
    },
    async remove(path, options) {
      await rm(await resolveContainedPath(storageRoot, path, false), {
        recursive: options?.recursive ?? false,
      });
    },
  };
}

async function resolveContainedPath(root: string, path: string, allowRoot = true): Promise<string> {
  if (path.includes('\0')) throw new Error('Paths cannot contain NUL bytes');

  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(root, path);
  assertContained(root, resolvedPath, allowRoot);

  const resolvedRoot = await realpath(root);
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
  return resolvedPath;
}

function assertContained(root: string, path: string, allowRoot: boolean): void {
  const relativePath = relative(root, path);
  const contained = relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));

  if (!contained) throw new Error(`Path escapes runtime root: ${path}`);
  if (!allowRoot && relativePath === '') throw new Error('The runtime root cannot be removed');
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
