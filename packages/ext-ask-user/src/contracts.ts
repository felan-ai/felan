import type {
  ExtensionContext,
  ToolDefinition,
} from '@felan-ai/agent-core';

export type AskUserDisplayMode = 'overlay' | 'inline';
export type AskUserSingleSelectLayout = 'auto' | 'list';

export interface AskUserOption {
  readonly title: string;
  readonly description?: string;
}

export interface AskUserOptionAliasInput {
  readonly title?: string | number | boolean;
  readonly label?: string | number | boolean;
  readonly text?: string | number | boolean;
  readonly value?: string | number | boolean;
  readonly name?: string | number | boolean;
  readonly option?: string | number | boolean;
  readonly description?: string;
}

export type AskUserOptionInput = string | number | boolean | AskUserOptionAliasInput;

export interface AskUserQuestionInput {
  readonly question: string;
  readonly header?: string;
  readonly context?: string;
  readonly options?: readonly AskUserOptionInput[];
  readonly allowMultiple?: boolean;
  readonly allowFreeform?: boolean;
  readonly allowComment?: boolean;
}

export interface AskUserInput extends Partial<AskUserQuestionInput> {
  readonly questions?: readonly AskUserQuestionInput[];
  readonly displayMode?: AskUserDisplayMode;
  readonly singleSelectLayout?: AskUserSingleSelectLayout;
  readonly overlayToggleKey?: string | null;
  readonly commentToggleKey?: string | null;
  readonly timeout?: number;
}

export interface AskUserQuestion {
  readonly id: string;
  readonly question: string;
  readonly header: string;
  readonly context?: string;
  readonly options: readonly AskUserOption[];
  readonly allowMultiple: boolean;
  readonly allowFreeform: boolean;
  readonly allowComment: boolean;
}

export interface AskUserRequest {
  readonly questions: readonly AskUserQuestion[];
  readonly displayMode?: AskUserDisplayMode;
  readonly singleSelectLayout?: AskUserSingleSelectLayout;
  readonly overlayToggleKey?: string | null;
  readonly commentToggleKey?: string | null;
  readonly timeout?: number;
}

export type AskUserResponse =
  | {
    readonly kind: 'selection';
    readonly selections: readonly string[];
    readonly comment?: string;
  }
  | {
    readonly kind: 'freeform';
    readonly text: string;
  };

export interface AskUserQuestionAnswer {
  readonly questionId: string;
  readonly response: AskUserResponse | null;
}

export interface AskUserAnsweredOutcome {
  readonly status: 'answered';
  readonly answers: readonly AskUserQuestionAnswer[];
}

export type AskUserCancellationReason = 'user' | 'timeout' | 'abort' | 'unavailable';

export interface AskUserCancelledOutcome {
  readonly status: 'cancelled';
  readonly reason: AskUserCancellationReason;
  readonly message?: string;
}

export interface AskUserDeferredOutcome {
  readonly status: 'deferred';
  readonly interactionId: string;
  readonly message?: string;
}

export type AskUserHostOutcome =
  | AskUserAnsweredOutcome
  | AskUserCancelledOutcome
  | AskUserDeferredOutcome;

export interface AskUserHostExecutionContext {
  readonly requestId: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly extensionContext: ExtensionContext;
  reportProgress(answers: readonly AskUserQuestionAnswer[]): void;
}

export type AskUserToolDetails =
  | {
    readonly kind: 'single';
    readonly status: 'pending' | AskUserHostOutcome['status'];
    readonly question: AskUserQuestion;
    readonly response: AskUserResponse | null;
    readonly reason?: AskUserCancellationReason;
    readonly message?: string;
    readonly interactionId?: string;
  }
  | {
    readonly kind: 'wizard';
    readonly status: 'pending' | AskUserHostOutcome['status'];
    readonly questions: readonly AskUserQuestion[];
    readonly responses: Readonly<Record<string, AskUserResponse | null>>;
    readonly reason?: AskUserCancellationReason;
    readonly message?: string;
    readonly interactionId?: string;
  };

export interface AskUserToolErrorDetails {
  readonly error: string;
}

export type AskUserToolPresentation = Pick<
  ToolDefinition<any, AskUserToolDetails | AskUserToolErrorDetails, any>,
  'renderCall' | 'renderResult'
>;

export interface AskUserHost {
  ask(
    request: AskUserRequest,
    context: AskUserHostExecutionContext,
  ): Promise<AskUserHostOutcome>;
  readonly toolPresentation?: AskUserToolPresentation;
}
