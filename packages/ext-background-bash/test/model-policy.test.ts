import type { Api, Model } from '@felan-ai/agent-core';
import { describe, expect, it } from 'vitest';
import { supportsBackgroundBashModel } from '../src/index.js';

describe('background bash model policy', () => {
  it.each([
    ['openai', false],
    ['openai-codex', false],
    ['anthropic', true],
    ['google', true],
    ['custom-provider', true],
  ] as const)('handles %s providers', (provider, expected) => {
    expect(supportsBackgroundBashModel({ provider } as Model<Api>)).toBe(expected);
  });

  it('waits for a selected model before activation', () => {
    expect(supportsBackgroundBashModel(undefined)).toBe(false);
  });
});
