import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from '@felan-ai/agent-core';

export type SessionTitleMode = 'tui' | 'rpc' | 'json' | 'print';

export interface SessionTitlePreparationRequest {
  readonly sessionId: string;
  readonly prompt: string;
  readonly mode: SessionTitleMode;
  readonly currentModel: Model<Api> | undefined;
  readonly parentSession: string | undefined;
  readonly signal: AbortSignal;
}

export interface SessionTitlePreparation {
  readonly prompt: string;
  readonly provider: string;
  readonly models: readonly Model<Api>[];
}

export interface SessionTitleCompletionRequest {
  readonly sessionId: string;
  readonly requestId: string;
  readonly model: Model<Api>;
  readonly context: Context;
  readonly options: SimpleStreamOptions;
}

export interface SessionTitlePersistenceRequest {
  readonly sessionId: string;
  readonly requestId: string;
  readonly title: string;
  readonly response: AssistantMessage;
}

export type SessionTitleFailureStage = 'prepare' | 'complete' | 'persist';

export type SessionTitleSkipReason =
  | 'non-tui-mode'
  | 'forked-session'
  | 'resumed-session'
  | 'model-unavailable'
  | 'host-declined'
  | 'no-text-models'
  | 'empty-prompt'
  | 'empty-response'
  | 'empty-title'
  | 'unexpected-stop-reason'
  | 'title-already-set'
  | 'persist-declined'
  | 'aborted';

export interface SessionTitleSkip {
  readonly sessionId: string;
  readonly reason: SessionTitleSkipReason;
  readonly detail?: string;
}

export interface SessionTitleFailure {
  readonly sessionId: string;
  readonly stage: SessionTitleFailureStage;
  readonly error: unknown;
}

export interface SessionTitleHost {
  prepare(
    request: SessionTitlePreparationRequest,
  ): Promise<SessionTitlePreparation | undefined>;

  complete(request: SessionTitleCompletionRequest): Promise<AssistantMessage>;

  setTitleIfMissing?(
    request: SessionTitlePersistenceRequest,
  ): Promise<boolean>;

  reportError?(failure: SessionTitleFailure): void | Promise<void>;

  reportSkip?(skip: SessionTitleSkip): void | Promise<void>;
}
