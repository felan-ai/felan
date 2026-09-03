import type { FelanThinkingLevel } from '@felan-ai/agent-core';

export type SubagentThinking = FelanThinkingLevel;

export interface SubagentDescriptor {
  readonly id: string;
  readonly description: string;
  readonly model?: string;
  readonly thinking?: SubagentThinking;
  readonly defaultMaxTurns?: number;
  readonly defaultTimeoutSeconds?: number;
  readonly allowNesting: boolean;
}

export interface SubagentPolicy {
  readonly maxPromptBytes: number;
  readonly maxDescriptionBytes: number;
  readonly maxSteerBytes: number;
}

export interface SubagentSpawnRequest {
  readonly type: string;
  readonly description: string;
  readonly prompt: string;
  readonly model?: string;
  readonly thinking?: SubagentThinking;
  readonly maxTurns?: number;
  readonly timeoutSeconds?: number;
}

export type SubagentStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export type SubagentErrorCode =
  | 'unknown_agent_type'
  | 'invalid_request'
  | 'unsupported_model'
  | 'unsupported_thinking'
  | 'depth_exceeded'
  | 'turn_limit_reached'
  | 'model_request_failed'
  | 'cancelled_by_parent'
  | 'timed_out'
  | 'host_shutdown'
  | 'not_found'
  | 'not_child'
  | 'not_steerable'
  | 'parent_unavailable'
  | 'host_unavailable'
  | 'internal_error';

export interface SubagentError {
  readonly code: SubagentErrorCode;
  readonly message: string;
}

export interface SubagentRecord {
  readonly agentId: string;
  readonly parentSessionId: string;
  readonly rootSessionId: string;
  readonly type: string;
  readonly description: string;
  readonly status: SubagentStatus;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly result?: string;
  readonly error?: SubagentError;
}

export type SubagentHostResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SubagentError };

export type SubagentTerminalStatus = Extract<
  SubagentStatus,
  'completed' | 'failed' | 'timed_out' | 'cancelled'
>;

export interface SubagentCompletionNotice {
  readonly deliveryId: string;
  readonly parentSessionId: string;
  readonly agentId: string;
  readonly type: string;
  readonly status: SubagentTerminalStatus;
  readonly summary?: string;
  readonly error?: SubagentError;
}

export interface SubagentParentPort {
  deliverCompletion(
    notice: SubagentCompletionNotice,
  ): Promise<'delivered' | 'queued' | 'unavailable'>;
  acknowledgeCompletion?(deliveryId: string): void;
}

export interface SubagentHost {
  readonly descriptors: readonly SubagentDescriptor[];
  readonly policy: SubagentPolicy;

  attachParent(port: SubagentParentPort): () => void;

  spawn(
    request: SubagentSpawnRequest,
    signal?: AbortSignal,
  ): Promise<SubagentHostResult<SubagentRecord>>;

  list(
    options: { readonly includeDescendants: boolean; readonly limit?: number },
  ): Promise<SubagentHostResult<readonly SubagentRecord[]>>;

  getResult(
    agentId: string,
    options?: { readonly acknowledge?: boolean },
  ): Promise<SubagentHostResult<SubagentRecord>>;

  steer(
    agentId: string,
    message: string,
  ): Promise<SubagentHostResult<SubagentRecord>>;

  cancel(
    agentId: string,
    reason?: string,
  ): Promise<SubagentHostResult<SubagentRecord>>;
}
