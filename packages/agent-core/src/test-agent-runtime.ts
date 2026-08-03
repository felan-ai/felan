import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { AgentRuntime, AgentRuntimeKind, ExecOptions, ExecResult } from './runtime.js';

export type TestShellOptions = ExecOptions & {
  env?: Readonly<Record<string, string>>;
};

export interface TestExecCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options?: ExecOptions;
}

export interface TestShellCall {
  readonly command: string;
  readonly options?: TestShellOptions;
}

export interface TestAgentRuntimeOptions {
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
  readonly #symlinks = new Map<string, string>();

  readonly execCalls: TestExecCall[] = [];
  readonly shellCalls: TestShellCall[] = [];

  constructor(cwd = '/workspace', options: TestAgentRuntimeOptions = {}) {
    this.#cwd = resolve(cwd);
    this.#kind = options.kind ?? 'host';
    this.#execHandler = options.exec ?? successResult;
    this.#shellHandler = options.shell ?? successResult;
    this.#directories.add(this.#cwd);
  }

  get cwd(): string {
    return this.#cwd;
  }

  get kind(): AgentRuntimeKind {
    return this.#kind;
  }

  async exec(command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult> {
    const normalizedOptions = this.#normalizeExecOptions(options);
    if (normalizedOptions?.signal?.aborted) {
      return this.#killedResult();
    }

    const call: TestExecCall = normalizedOptions
      ? { command, args: [...args], options: normalizedOptions }
      : { command, args: [...args] };
    this.execCalls.push(call);
    return this.#run(() => this.#execHandler(call), normalizedOptions);
  }

  async shell(command: string, options?: TestShellOptions): Promise<ExecResult> {
    const normalizedOptions = this.#normalizeShellOptions(options);
    if (normalizedOptions?.signal?.aborted) {
      return this.#killedResult();
    }

    const call: TestShellCall = normalizedOptions ? { command, options: normalizedOptions } : { command };
    this.shellCalls.push(call);
    return this.#run(() => this.#shellHandler(call), normalizedOptions);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const resolvedPath = this.#resolvePath(path);
    const content = this.#files.get(resolvedPath);
    if (!content) {
      throw new Error(`File does not exist: ${path}`);
    }
    return content.slice();
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    const resolvedPath = this.#resolvePath(path, false);
    if (!this.#directories.has(dirname(resolvedPath))) {
      throw new Error(`Parent directory does not exist: ${path}`);
    }
    this.#files.set(resolvedPath, content.slice());
  }

  async listFiles(path: string, options?: { recursive?: boolean }): Promise<string[]> {
    const resolvedPath = this.#resolvePath(path);
    if (!this.#directories.has(resolvedPath)) {
      throw new Error(`Directory does not exist: ${path}`);
    }

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
      const pending = [];
      while (current !== this.#cwd && !this.#directories.has(current)) {
        pending.push(current);
        current = dirname(current);
      }
      for (const directory of pending.reverse()) {
        this.#directories.add(directory);
      }
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
    const descendants = [...this.#files.keys(), ...this.#directories, ...this.#symlinks.keys()]
      .filter((entry) => entry.startsWith(prefix));

    if (descendants.length > 0 && !options?.recursive) {
      throw new Error(`Directory is not empty: ${path}`);
    }

    this.#files.delete(resolvedPath);
    this.#directories.delete(resolvedPath);
    this.#symlinks.delete(resolvedPath);
    if (options?.recursive) {
      for (const entry of descendants) {
        this.#files.delete(entry);
        this.#directories.delete(entry);
        this.#symlinks.delete(entry);
      }
    }
  }

  addSymlink(path: string, target: string): void {
    const linkPath = this.#resolvePath(path, false, false);
    const targetPath = isAbsolute(target) ? resolve(target) : resolve(dirname(linkPath), target);
    this.#symlinks.set(linkPath, targetPath);
  }

  #normalizeExecOptions(options?: ExecOptions): ExecOptions | undefined {
    if (!options) {
      return undefined;
    }
    const normalized: ExecOptions = {};
    if (options.cwd !== undefined) normalized.cwd = this.#resolvePath(options.cwd);
    if (options.signal !== undefined) normalized.signal = options.signal;
    if (options.timeout !== undefined) normalized.timeout = options.timeout;
    return normalized;
  }

  #normalizeShellOptions(options?: TestShellOptions): TestShellOptions | undefined {
    const normalized = this.#normalizeExecOptions(options);
    if (!options?.env) {
      return normalized;
    }
    return { ...normalized, env: { ...options.env } };
  }

  async #run(
    handler: () => ExecResult | Promise<ExecResult>,
    options?: ExecOptions,
  ): Promise<ExecResult> {
    if ((!options?.timeout || options.timeout <= 0) && !options?.signal) {
      return handler();
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const cancellation = new Promise<ExecResult>((resolveCancellation) => {
      if (options?.timeout && options.timeout > 0) {
        timeout = setTimeout(() => resolveCancellation(this.#killedResult()), options.timeout);
      }
      if (options?.signal) {
        abortListener = () => resolveCancellation(this.#killedResult());
        options.signal.addEventListener('abort', abortListener, { once: true });
      }
    });

    try {
      return await Promise.race([handler(), cancellation]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortListener && options?.signal) {
        options.signal.removeEventListener('abort', abortListener);
      }
    }
  }

  #killedResult(): ExecResult {
    return { stdout: '', stderr: '', code: 143, killed: true };
  }

  #resolvePath(path: string, allowRoot = true, followSymlinks = true): string {
    if (path.includes('\0')) {
      throw new Error('Paths cannot contain NUL bytes');
    }

    let resolvedPath = isAbsolute(path) ? resolve(path) : resolve(this.#cwd, path);
    this.#assertContained(resolvedPath, allowRoot);

    if (followSymlinks) {
      const relativePath = relative(this.#cwd, resolvedPath);
      const segments = relativePath === '' ? [] : relativePath.split(sep);
      let current = this.#cwd;
      for (let index = 0; index < segments.length; index += 1) {
        current = resolve(current, segments[index]!);
        const target = this.#symlinks.get(current);
        if (target) {
          resolvedPath = resolve(target, ...segments.slice(index + 1));
          this.#assertContained(resolvedPath, allowRoot);
          break;
        }
      }
    }

    return resolvedPath;
  }

  #assertContained(path: string, allowRoot: boolean): void {
    const relativePath = relative(this.#cwd, path);
    const contained = relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
    if (!contained) {
      throw new Error(`Path escapes runtime cwd: ${path}`);
    }
    if (!allowRoot && relativePath === '') {
      throw new Error('The runtime cwd cannot be modified or removed');
    }
  }
}
