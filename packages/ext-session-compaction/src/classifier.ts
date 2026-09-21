export const COMPACTION_CHOICE_CRITERIA = {
  exact_contents:
    'Specific values in this output (paths, names, numbers, error text, code) are needed to continue or to answer follow-up questions, and no later assistant message, edit, or checkpoint records them.',
  outcome_only:
    'It matters that this was done and roughly what it found, so the agent does not repeat or contradict it, but the exact contents are not needed.',
  obsolete:
    'It was acted on and its outcome is recorded elsewhere, or a later change superseded it, or it is unrelated to the goal. Nothing is lost if it disappears.',
} as const;

export type CompactionClassifierChoice = keyof typeof COMPACTION_CHOICE_CRITERIA;

export interface CompactionClassifierQuestion {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: typeof COMPACTION_CHOICE_CRITERIA;
}

export interface CompactionClassifierChoiceAnswer {
  readonly type: 'choice';
  readonly choice: CompactionClassifierChoice;
  readonly probabilities?: Readonly<Partial<Record<CompactionClassifierChoice, number>>>;
  readonly confidence?: number;
}
