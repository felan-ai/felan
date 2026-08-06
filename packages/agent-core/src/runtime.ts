import type { ExecOptions, ExecResult } from '@earendil-works/pi-coding-agent';

export type { ExecOptions, ExecResult } from '@earendil-works/pi-coding-agent';

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

export interface AgentRuntimeStorage {
  readonly root: string;

  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  listFiles(path: string, options?: { recursive?: boolean }): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface AgentRuntimeFileReadOptions {
  readonly maxBytes?: number;
}

export interface AgentRuntimeFileWriteOptions {
  readonly exclusive?: boolean;
}

export interface AgentRuntime {
  readonly kind: AgentRuntimeKind;
  readonly cwd: string;
  readonly processes?: AgentRuntimeProcesses;

  storage(scope?: AgentRuntimeStorageScope): AgentRuntimeStorage;

  exec(
    command: string,
    args: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult>;

  shell(
    command: string,
    options?: ExecOptions & { env?: Readonly<Record<string, string>> },
  ): Promise<ExecResult>;

  readFile(path: string, options?: AgentRuntimeFileReadOptions): Promise<Uint8Array>;
  writeFile(
    path: string,
    content: Uint8Array,
    options?: AgentRuntimeFileWriteOptions,
  ): Promise<void>;
  listFiles(path: string, options?: { recursive?: boolean }): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;

  readAgentFile?(path: string): Promise<Uint8Array>;
}
