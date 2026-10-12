import { join } from 'node:path';
import type { AgentRuntime } from '@felan-ai/agent-core';

export interface LocalAgentRuntimeFactoryRequest {
  readonly cwd: string;
  readonly agentDir: string;
  readonly rootSessionId: string;
  readonly sessionStorageRoot: string;
  readonly agentStorageRoot: string;
  readonly pathAccess: 'host';
}

export type LocalAgentRuntimeFactory = (
  request: LocalAgentRuntimeFactoryRequest,
) => AgentRuntime;

export function createLocalAgentRuntimeFactoryRequest(
  cwd: string,
  agentDir: string,
  rootSessionId: string,
): LocalAgentRuntimeFactoryRequest {
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
