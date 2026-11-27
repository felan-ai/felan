import type { AgentRuntime } from '@felan-ai/agent-core';

export interface ProcessRecord {
  readonly id: string;
  readonly kind: 'pty' | 'detached';
  readonly status: 'running' | 'completed' | 'failed' | 'killed' | 'unknown';
  readonly command: string;
  readonly startedAt: number;
  readonly startIdentity?: string;
  readonly outputPath: string;
  readonly commandIdentity: readonly string[];
  readonly exitCode?: number;
  /** The job still owes its session a finish notice; recovery restores that session so the notice is delivered. */
  readonly notice?: 'pending';
}

export interface DetachedProcessInspection {
  readonly status: ProcessRecord['status'];
  readonly pid?: number;
  /**
   * Whether the adapter matched `pid` to the job's own runner. A Windows host relies on it instead of its own process
   * inspection, because processes of a POSIX layer such as Git Bash have process IDs that Windows does not know.
   */
  readonly verified?: boolean;
}

export interface ProcessAdapter {
  storageDirectory(runtime: AgentRuntime): string;
  describeJob(runtime: AgentRuntime, path: string, bytes: Uint8Array): ProcessRecord | undefined;
  /** Remote providers read in the runtime namespace; the default reads daemon-owned local files. */
  readOutputRange?(runtime: AgentRuntime, path: string, offset: number, limit: number): Promise<Uint8Array>;
  inspectDetached(runtime: AgentRuntime, id: string): Promise<DetachedProcessInspection>;
  stopDetached(runtime: AgentRuntime, id: string, signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
}
