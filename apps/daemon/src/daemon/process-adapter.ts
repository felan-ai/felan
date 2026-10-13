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
}

export interface DetachedProcessInspection {
  readonly status: ProcessRecord['status'];
  readonly pid?: number;
}

export interface ProcessAdapter {
  storageDirectory(runtime: AgentRuntime): string;
  describeJob(runtime: AgentRuntime, path: string, bytes: Uint8Array): ProcessRecord | undefined;
  inspectDetached(runtime: AgentRuntime, id: string): Promise<DetachedProcessInspection>;
  stopDetached(runtime: AgentRuntime, id: string, signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
}
