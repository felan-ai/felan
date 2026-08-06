import type { ExecOptions, ExecResult } from '@earendil-works/pi-coding-agent';

export type { ExecOptions, ExecResult } from '@earendil-works/pi-coding-agent';

export type AgentRuntimeKind = 'host' | 'docker' | 'daytona';

export type AgentRuntimeStorageScope = 'session' | 'agent';

export interface AgentRuntimeStorage {
  readonly root: string;

  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  listFiles(path: string, options?: { recursive?: boolean }): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface AgentRuntime {
  readonly kind: AgentRuntimeKind;
  readonly cwd: string;

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

  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  listFiles(path: string, options?: { recursive?: boolean }): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
}
