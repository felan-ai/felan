import { join } from 'node:path';
import type { AgentRuntime } from '@felan-ai/agent-core';

export interface RuntimeStorageRequest {
  readonly cwd: string;
  readonly agentDir: string;
  readonly rootSessionId: string;
  readonly sessionStorageRoot: string;
  readonly agentStorageRoot: string;
  readonly pathAccess: 'host';
}

export type RuntimeFactory = (
  request: RuntimeStorageRequest,
) => AgentRuntime;

export function createRuntimeStorageRequest(
  cwd: string,
  agentDir: string,
  rootSessionId: string,
): RuntimeStorageRequest {
  return {
    cwd,
    agentDir,
    rootSessionId,
    pathAccess: 'host',
    sessionStorageRoot: join(
      agentDir,
      'storage',
      'sessions',
      encodeURIComponent(rootSessionId),
    ),
    agentStorageRoot: join(agentDir, 'storage', 'agent'),
  };
}
