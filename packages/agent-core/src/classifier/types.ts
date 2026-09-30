export interface ClassifierChoiceQuestion {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

export interface ClassifierBoolQuestion {
  readonly type: 'bool';
  readonly instructions: string;
  readonly criteria: { readonly true: string; readonly false: string };
}

export interface ClassifierScoreQuestion {
  readonly type: 'score';
  readonly instructions: string;
  readonly criteria: readonly string[];
}

export type ClassifierQuestion = ClassifierChoiceQuestion | ClassifierBoolQuestion | ClassifierScoreQuestion;

export type ClassifierQuestions = Readonly<Record<string, ClassifierQuestion>>;

export interface ClassifierChoiceAnswer {
  readonly type: 'choice';
  readonly choice: string;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly confidence?: number;
}

export interface ClassifierBoolAnswer {
  readonly type: 'bool';
  readonly probability: number;
}

export interface ClassifierScoreAnswer {
  readonly type: 'score';
  readonly score: number;
  readonly confidence?: number;
}

export type ClassifierAnswer = ClassifierChoiceAnswer | ClassifierBoolAnswer | ClassifierScoreAnswer;

export type ClassifierAnswers = Readonly<Record<string, ClassifierAnswer>>;

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
  canEvaluate?(state: unknown, questions: ClassifierQuestions): boolean;
  classify(
    state: unknown,
    questions: ClassifierQuestions,
    signal?: AbortSignal,
  ): Promise<{
    readonly answers: ClassifierAnswers;
    readonly metadata?: ClassifierEvaluationMetadata;
  }>;
}
