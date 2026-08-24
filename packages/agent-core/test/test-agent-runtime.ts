import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  AgentRuntime,
  AgentRuntimeExecOptions,
  AgentRuntimeFileReadOptions,
  AgentRuntimeFileWriteOptions,
  AgentRuntimeKind,
  AgentRuntimeShellOptions,
  AgentRuntimeStorage,
  AgentRuntimeStorageScope,
  ExecResult,
} from '../src/runtime.js';

type TestShellOptions = AgentRuntimeShellOptions;

interface TestExecCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options?: AgentRuntimeExecOptions;
}

interface TestShellCall {
  readonly command: string;
  readonly options?: TestShellOptions;
}

interface TestAgentRuntimeOptions {
  readonly kind?: AgentRuntimeKind;
  readonly exec?: (call: TestExecCall) => ExecResult | Promise<ExecResult>;
  readonly shell?: (call: TestShellCall) => ExecResult | Promise<ExecResult>;
}

const successResult = (): ExecResult => ({
  stdout: '',
  stderr: '',
  code: 0,
  killed: false,
});

export class TestAgentRuntime implements AgentRuntime {
  readonly #cwd: string;
  readonly #kind: AgentRuntimeKind;
  readonly #execHandler: NonNullable<TestAgentRuntimeOptions['exec']>;
  readonly #shellHandler: NonNullable<TestAgentRuntimeOptions['shell']>;
  readonly #files = new Map<string, Uint8Array>();
  readonly #directories = new Set<string>();

  readonly execCalls: TestExecCall[] = [];
  readonly shellCalls: TestShellCall[] = [];
  readonly #storage: Record<AgentRuntimeStorageScope, AgentRuntimeStorage>;

  constructor(cwd = '/workspace', options: TestAgentRuntimeOptions = {}) {
    this.#cwd = resolve(cwd);
    this.#kind = options.kind ?? 'host';
    this.#execHandler = options.exec ?? successResult;
    this.#shellHandler = options.shell ?? successResult;
    this.#directories.add(this.#cwd);
    const sessionStorageRoot = resolve(this.#cwd, '.runtime-storage', 'session');
    const agentStorageRoot = resolve(this.#cwd, '.runtime-storage', 'agent');
    this.#directories.add(dirname(sessionStorageRoot));
    this.#directories.add(sessionStorageRoot);
    this.#directories.add(agentStorageRoot);
    this.#storage = {
      session: this.#createStorage(sessionStorageRoot),
      agent: this.#createStorage(agentStorageRoot),
    };
  }

  get cwd(): string {
    return this.#cwd;
  }

  get kind(): AgentRuntimeKind {
    return this.#kind;
  }

  storage(scope: AgentRuntimeStorageScope = 'session'): AgentRuntimeStorage {
    return this.#storage[scope];
  }

  async exec(command: string, args: readonly string[], options?: AgentRuntimeExecOptions): Promise<ExecResult> {
    const normalizedOptions = this.#normalizeExecOptions(options);
    if (normalizedOptions?.signal?.aborted) return killedResult();
    const call: TestExecCall = normalizedOptions
      ? { command, args: [...args], options: normalizedOptions }
      : { command, args: [...args] };
    this.execCalls.push(call);
    return this.#run(() => this.#execHandler(call), normalizedOptions);
  }

  async shell(command: string, options?: TestShellOptions): Promise<ExecResult> {
    const normalizedOptions = this.#normalizeShellOptions(options);
    if (normalizedOptions?.signal?.aborted) return killedResult();
    const call: TestShellCall = normalizedOptions ? { command, options: normalizedOptions } : { command };
    this.shellCalls.push(call);
    return this.#run(() => this.#shellHandler(call), normalizedOptions);
  }

  async readFile(path: string, options?: AgentRuntimeFileReadOptions): Promise<Uint8Array> {
    const content = this.#files.get(this.#resolvePath(path));
    if (!content) throw new Error(`File does not exist: ${path}`);
    if (options?.maxBytes !== undefined && content.byteLength > options.maxBytes) {
      throw new Error(`File exceeds maximum size of ${options.maxBytes} bytes`);
    }
    return content.slice();
  }

  async writeFile(
    path: string,
    content: Uint8Array,
    options?: AgentRuntimeFileWriteOptions,
  ): Promise<void> {
    const resolvedPath = this.#resolvePath(path, false);
    if (!this.#directories.has(dirname(resolvedPath))) {
      throw new Error(`Parent directory does not exist: ${path}`);
    }
    if (options?.exclusive && this.#files.has(resolvedPath)) {
      throw Object.assign(new Error(`File already exists: ${path}`), { code: 'EEXIST' });
    }
    this.#files.set(resolvedPath, content.slice());
  }

  async listFiles(path: string, options?: { recursive?: boolean }): Promise<string[]> {
    const resolvedPath = this.#resolvePath(path);
    if (!this.#directories.has(resolvedPath)) throw new Error(`Directory does not exist: ${path}`);
    const prefix = `${resolvedPath}${sep}`;
    return [...this.#files.keys()]
      .filter((filePath) => filePath.startsWith(prefix))
      .map((filePath) => relative(resolvedPath, filePath))
      .filter((filePath) => options?.recursive || !filePath.includes(sep))
      .sort();
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const resolvedPath = this.#resolvePath(path);
    if (options?.recursive) {
      let current = resolvedPath;
      const pending: string[] = [];
      while (current !== this.#cwd && !this.#directories.has(current)) {
        pending.push(current);
        current = dirname(current);
      }
      for (const directory of pending.reverse()) this.#directories.add(directory);
      return;
    }
    if (!this.#directories.has(dirname(resolvedPath))) {
      throw new Error(`Parent directory does not exist: ${path}`);
    }
    this.#directories.add(resolvedPath);
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    const resolvedPath = this.#resolvePath(path, false);
    const prefix = `${resolvedPath}${sep}`;
    const descendants = [...this.#files.keys(), ...this.#directories]
      .filter((entry) => entry.startsWith(prefix));
    if (descendants.length > 0 && !options?.recursive) throw new Error(`Directory is not empty: ${path}`);
    this.#files.delete(resolvedPath);
    this.#directories.delete(resolvedPath);
    if (options?.recursive) {
      for (const entry of descendants) {
        this.#files.delete(entry);
        this.#directories.delete(entry);
      }
    }
  }

  #createStorage(root: string): AgentRuntimeStorage {
    return {
      root,
      readFile: async (path) => {
        const content = this.#files.get(this.#resolveStoragePath(root, path));
        if (!content) throw new Error(`File does not exist: ${path}`);
        return content.slice();
      },
      writeFile: async (path, content) => {
        const resolvedPath = this.#resolveStoragePath(root, path);
        if (!this.#directories.has(dirname(resolvedPath))) {
          throw new Error(`Parent directory does not exist: ${path}`);
        }
        this.#files.set(resolvedPath, content.slice());
      },
      listFiles: async (path, options) => {
        const resolvedPath = this.#resolveStoragePath(root, path);
        if (!this.#directories.has(resolvedPath)) throw new Error(`Directory does not exist: ${path}`);
        const prefix = `${resolvedPath}${sep}`;
        return [...this.#files.keys()]
          .filter((filePath) => filePath.startsWith(prefix))
          .map((filePath) => relative(resolvedPath, filePath))
          .filter((filePath) => options?.recursive || !filePath.includes(sep))
          .sort();
      },
      mkdir: async (path, options) => {
        const resolvedPath = this.#resolveStoragePath(root, path);
        if (options?.recursive) {
          let current = resolvedPath;
          const pending: string[] = [];
          while (current !== root && !this.#directories.has(current)) {
            pending.push(current);
            current = dirname(current);
          }
          for (const directory of pending.reverse()) this.#directories.add(directory);
          return;
        }
        if (!this.#directories.has(dirname(resolvedPath))) {
          throw new Error(`Parent directory does not exist: ${path}`);
        }
        this.#directories.add(resolvedPath);
      },
      remove: async (path, options) => {
        const resolvedPath = this.#resolveStoragePath(root, path, false);
        const prefix = `${resolvedPath}${sep}`;
        const descendants = [...this.#files.keys(), ...this.#directories]
          .filter((entry) => entry.startsWith(prefix));
        if (descendants.length > 0 && !options?.recursive) {
          throw new Error(`Directory is not empty: ${path}`);
        }
        this.#files.delete(resolvedPath);
        this.#directories.delete(resolvedPath);
        if (options?.recursive) {
          for (const entry of descendants) {
            this.#files.delete(entry);
            this.#directories.delete(entry);
          }
        }
      },
    };
  }

  #resolveStoragePath(root: string, path: string, allowRoot = true): string {
    if (path.includes('\0')) throw new Error('Paths cannot contain NUL bytes');
    const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(root, path);
    const relativePath = relative(root, resolvedPath);
    const contained = relativePath === ''
      || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
    if (!contained) throw new Error(`Path escapes runtime storage: ${path}`);
    if (!allowRoot && relativePath === '') throw new Error('The runtime storage root cannot be removed');
    return resolvedPath;
  }

  #normalizeExecOptions(options?: AgentRuntimeExecOptions): AgentRuntimeExecOptions | undefined {
    if (!options) return undefined;
    return {
      ...(options.cwd === undefined ? {} : { cwd: this.#resolvePath(options.cwd) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    };
  }

  #normalizeShellOptions(options?: TestShellOptions): TestShellOptions | undefined {
    const normalized = this.#normalizeExecOptions(options);
    if (!options) return normalized;
    return {
      ...normalized,
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
      ...(options.shellFlavor === undefined ? {} : { shellFlavor: options.shellFlavor }),
    };
  }

  async #run(
    handler: () => ExecResult | Promise<ExecResult>,
    options?: AgentRuntimeExecOptions,
  ): Promise<ExecResult> {
    if ((!options?.timeout || options.timeout <= 0) && !options?.signal) return handler();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const cancellation = new Promise<ExecResult>((resolveCancellation) => {
      if (options?.timeout && options.timeout > 0) {
        timeout = setTimeout(() => resolveCancellation(killedResult()), options.timeout);
      }
      if (options?.signal) {
        abortListener = () => resolveCancellation(killedResult());
        options.signal.addEventListener('abort', abortListener, { once: true });
      }
    });
    try {
      return await Promise.race([handler(), cancellation]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortListener && options?.signal) options.signal.removeEventListener('abort', abortListener);
    }
  }

  #resolvePath(path: string, allowRoot = true): string {
    if (path.includes('\0')) throw new Error('Paths cannot contain NUL bytes');
    const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(this.#cwd, path);
    const relativePath = relative(this.#cwd, resolvedPath);
    const contained = relativePath === ''
      || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
    if (!contained) throw new Error(`Path escapes runtime cwd: ${path}`);
    if (!allowRoot && relativePath === '') throw new Error('The runtime cwd cannot be modified or removed');
    return resolvedPath;
  }
}

function killedResult(): ExecResult {
  return { stdout: '', stderr: '', code: 143, killed: true };
}
