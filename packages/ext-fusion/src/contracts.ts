import type { ExtensionCommandContext } from '@felan-ai/agent-core';

export interface FusionModelChoice {
  readonly reference: string;
  readonly label: string;
}

export interface FusionReview {
  readonly prompt: string;
  readonly participants: readonly string[];
  readonly fusionModel: string;
  readonly answers: readonly FusionAnswer[];
  readonly failures?: readonly FusionFailure[];
  readonly comparison?: FusionStageResult;
  readonly fused?: FusionStageResult;
  readonly updatedAt: number;
}

export interface FusionFailure {
  readonly model: string;
  readonly message: string;
}

export class FusionPanelError extends Error {
  readonly review: FusionReview;

  constructor(message: string, review: FusionReview) {
    super(message);
    this.name = 'FusionPanelError';
    this.review = review;
  }
}

export interface FusionAnswer extends FusionStageResult {
  readonly model: string;
  readonly actualModel?: string;
}

export interface FusionStageResult {
  readonly text: string;
  readonly model: string;
  readonly durationMs: number;
  readonly usage?: {
    readonly input: number;
    readonly output: number;
    readonly totalTokens: number;
    readonly estimatedCost: number;
  };
  readonly truncated?: boolean;
}

export interface FusionHost {
  selectRunAction?(
    context: ExtensionCommandContext,
    participants: readonly string[],
    fusionModel: string,
  ): Promise<'run' | 'change' | 'cancel'>;
  confirm(context: ExtensionCommandContext, participantCount: number): Promise<boolean>;
  configure(
    context: ExtensionCommandContext,
    models: readonly FusionModelChoice[],
    participants: readonly string[],
    fusionModel: string,
  ): Promise<{ readonly participants: readonly string[]; readonly fusionModel: string } | undefined>;
  review(context: ExtensionCommandContext, getReview: () => FusionReview, actions: FusionReviewActions): Promise<void>;
}

export interface FusionReviewActions {
  fuse(instruction?: string, model?: string): Promise<void>;
  retryParticipants(): Promise<void>;
  retryComparison(): Promise<void>;
  retryFusion(): Promise<void>;
  cancel(): void;
}

export interface FusionModelRequest {
  readonly prompt: string;
  readonly model: FusionModelChoice;
  readonly maxOutputChars: number;
  readonly signal: AbortSignal;
  readonly thinking: import('./config.js').FusionConfig['thinking'];
}
