export interface ClassifierQuestion {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

export type ClassifierQuestions = Readonly<Record<string, ClassifierQuestion>>;

export interface ClassifierAnswer {
  readonly type: 'choice';
  readonly choice: string;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly confidence?: number;
}

export type ClassifierAnswers = Readonly<Record<string, ClassifierAnswer>>;

export interface ClassifierProbabilityQuestion {
  readonly instructions: string;
}

export type ClassifierProbabilityQuestions = Readonly<Record<string, ClassifierProbabilityQuestion>>;

export interface ClassifierProbabilityAnswer {
  readonly probability: number;
}

export type ClassifierProbabilityAnswers = Readonly<Record<string, ClassifierProbabilityAnswer>>;

export interface ClassifierUsage {
  readonly requests: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

export interface ClassifierEvaluationMetadata {
  readonly provider?: string;
  readonly model?: string;
  readonly usage?: ClassifierUsage;
  readonly elapsedMs?: number;
}

export interface Classifier {
  evaluate(
    state: unknown,
    questions: ClassifierQuestions,
    signal?: AbortSignal,
  ): Promise<{
    readonly answers: ClassifierAnswers;
    readonly metadata?: ClassifierEvaluationMetadata;
  }>;
  evaluateProbabilities?(
    state: unknown,
    questions: ClassifierProbabilityQuestions,
    signal?: AbortSignal,
  ): Promise<{
    readonly answers: ClassifierProbabilityAnswers;
    readonly metadata?: ClassifierEvaluationMetadata;
  }>;
}
