import { type FelanThinkingLevel } from '@felan-ai/agent-core';

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
  readonly error?: string;
}

export type SubagentResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SubagentError };
