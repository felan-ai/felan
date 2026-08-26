import type {
  ExecOptions as PiExecOptions,
  ExecResult as PiExecResult,
} from '@earendil-works/pi-coding-agent';

export type ExecOptions = PiExecOptions;

export interface AgentRuntimeExecOptions extends PiExecOptions {
  /** Maximum combined stdout/stderr bytes retained by the host adapter. */
  readonly maxOutputBytes?: number;
}

export interface AgentRuntimeExecResult extends PiExecResult {
  /** True when the host discarded output after reaching maxOutputBytes. */
  readonly truncated?: boolean;
}

export type ExecResult = AgentRuntimeExecResult;

export type AgentRuntimeShellFlavor = 'default' | 'posix';

export interface AgentRuntimeShellOptions extends AgentRuntimeExecOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly shellFlavor?: AgentRuntimeShellFlavor;
}

export type AgentRuntimeKind = 'host' | 'docker' | 'daytona';

export type AgentRuntimeStorageScope = 'session' | 'agent';

export interface AgentRuntimeProcessReadOptions {
  readonly waitMs?: number;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

export interface AgentRuntimeProcessSnapshot {
  readonly output: Uint8Array;
  readonly nextOffset: number;
  readonly running: boolean;
  readonly exitCode?: number;
}

export interface AgentRuntimeProcess {
  readonly pid: number | undefined;

  read(afterOffset: number, options?: AgentRuntimeProcessReadOptions): Promise<AgentRuntimeProcessSnapshot>;
  write(content: Uint8Array): Promise<void>;
  interrupt?(): Promise<void>;
  terminate(): Promise<void>;
  dispose(): Promise<void>;
}

export interface AgentRuntimeShellProcessOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly shell?: string;
  readonly login?: boolean;
  readonly stdin?: boolean;
}

export interface AgentRuntimeProcesses {
  startShell(command: string, options?: AgentRuntimeShellProcessOptions): Promise<AgentRuntimeProcess>;
}

export interface AgentRuntimeTerminals {
  startShell(
    command: string,
    options?: AgentRuntimeShellProcessOptions,
  ): Promise<AgentRuntimeProcess>;
}

export interface AgentRuntimeStorage {
  readonly root: string;

  readFile(path: string, options?: AgentRuntimeFileReadOptions): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  listFiles(path: string, options?: AgentRuntimeListFilesOptions): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface AgentRuntimeFileReadOptions {
  readonly maxBytes?: number;
}

export interface AgentRuntimeFileWriteOptions {
  readonly exclusive?: boolean;
}

export interface AgentRuntimeListFilesOptions {
  /** Traverse descendants instead of returning only immediate entries. */
  readonly recursive?: boolean;
  /** Include directories as well as regular files in the returned paths. */
  readonly includeDirectories?: boolean;
  /** Maximum entry depth below the requested directory; immediate entries have depth 1. */
  readonly maxDepth?: number;
  /** Match returned paths with `/`-separated glob syntax. */
  readonly pattern?: string;
  /** Omit matching paths and prune matching directories before traversal. */
  readonly ignore?: readonly string[];
  /** Return at most this many entries, ordered by relative path. */
  readonly limit?: number;
  /** Stop traversal when the operation is cancelled. */
  readonly signal?: AbortSignal;
}

export interface AgentRuntime {
  readonly kind: AgentRuntimeKind;
  readonly cwd: string;
  readonly processes?: AgentRuntimeProcesses;
  readonly terminals?: AgentRuntimeTerminals;

  storage(scope?: AgentRuntimeStorageScope): AgentRuntimeStorage;

  exec(
    command: string,
    args: readonly string[],
    options?: AgentRuntimeExecOptions,
  ): Promise<ExecResult>;

  shell(
    command: string,
    options?: AgentRuntimeShellOptions,
  ): Promise<ExecResult>;

  readFile(path: string, options?: AgentRuntimeFileReadOptions): Promise<Uint8Array>;
  writeFile(
    path: string,
    content: Uint8Array,
    options?: AgentRuntimeFileWriteOptions,
  ): Promise<void>;
  listFiles(path: string, options?: AgentRuntimeListFilesOptions): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;

  readAgentFile?(path: string): Promise<Uint8Array>;
}
