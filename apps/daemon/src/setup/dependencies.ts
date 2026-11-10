import type { AgentRuntime } from '@felan-ai/agent-core';

export interface SetupDependency {
  id: string;
  extension: string;
  revision: number;
  requiredVersion?: string;
  label: string;
  description: string;
  providesModels?: boolean;
  check(runtime: AgentRuntime): Promise<{ available: boolean; version?: string; reason?: string }>;
  install?(runtime: AgentRuntime, progress: (message: string) => void): Promise<unknown>;
}
