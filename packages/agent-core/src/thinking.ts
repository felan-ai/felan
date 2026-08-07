export const FELAN_THINKING_LEVELS = [
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type FelanThinkingLevel = typeof FELAN_THINKING_LEVELS[number];

export function isFelanThinkingLevel(value: string | undefined): value is FelanThinkingLevel {
  return FELAN_THINKING_LEVELS.includes(value as FelanThinkingLevel);
}
