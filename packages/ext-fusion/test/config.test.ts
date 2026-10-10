import { describe, expect, it } from 'vitest';
import { FUSION_CONFIG, DEFAULT_FUSION_CONFIG } from '../src/config.js';

describe('Fusion configuration', () => {
  it('requires explicit participants and defaults fusion to the current model', () => {
    expect(DEFAULT_FUSION_CONFIG).toMatchObject({ participants: [], fusionModel: 'inherit' });
    expect(FUSION_CONFIG.fields.participants.validate?.([])).toBeUndefined();
  });

  it('accepts provider model IDs containing nested slashes', () => {
    expect(FUSION_CONFIG.fields.participants.validate?.([
      'openrouter/anthropic/claude-sonnet-4',
      'openai/gpt-5',
    ])).toBeUndefined();
    expect(FUSION_CONFIG.fields.fusionModel.validate?.('openrouter/openai/gpt-5')).toBeUndefined();
  });

  it('rejects duplicate, malformed, excessive and invalid bounded configuration', () => {
    expect(FUSION_CONFIG.fields.participants.validate?.(['openai/gpt-5', 'openai/gpt-5'])).toContain('unique');
    expect(FUSION_CONFIG.fields.participants.validate?.(['gpt-5'])).toContain('provider/model');
    expect(FUSION_CONFIG.fields.participants.validate?.(Array.from({ length: 9 }, (_, i) => `p/m${i}`))).toContain('at most eight');
    expect(FUSION_CONFIG.fields.concurrency.validate?.(0)).toContain('between 1 and 8');
    expect(FUSION_CONFIG.fields.timeoutSeconds.validate?.(9)).toContain('between 10 and 600');
    expect(FUSION_CONFIG.fields.maxOutputChars.validate?.(50001)).toContain('between 1000 and 50000');
  });
});
