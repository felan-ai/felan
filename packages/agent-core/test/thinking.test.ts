import { describe, expect, it } from 'vitest';
import { FELAN_THINKING_LEVELS, isFelanThinkingLevel } from '../src/index.js';

describe('Felan thinking levels', () => {
  it('keeps thinking independent from model tiers', () => {
    expect(FELAN_THINKING_LEVELS).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(isFelanThinkingLevel('max')).toBe(true);
    expect(isFelanThinkingLevel('minimal')).toBe(false);
  });
});
