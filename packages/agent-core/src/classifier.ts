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

export interface Classifier {
  evaluate(
    state: unknown,
    questions: ClassifierQuestions,
    signal?: AbortSignal,
  ): Promise<{ readonly answers: ClassifierAnswers }>;
}
