import type { AgentRuntime } from '@felan-ai/agent-core';

export interface SetupDependency {
  id: string;
  extension: string;
  revision: number;
  label: string;
  description: string;
  check(runtime: AgentRuntime): Promise<{ available: boolean; version?: string; reason?: string }>;
  install?(runtime: AgentRuntime, progress: (message: string) => void): Promise<unknown>;
}
