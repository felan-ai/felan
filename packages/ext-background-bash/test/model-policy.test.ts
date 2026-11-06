import type { AgentRuntime, Api, Model } from '@felan-ai/agent-core';
import { describe, expect, it } from 'vitest';
import { inspectBackgroundBashRuntime, supportsBackgroundBashModel } from '../src/index.js';

describe('background bash model policy', () => {
  it.each([
    ['openai', true],
    ['openai-codex', true],
    ['anthropic', true],
    ['google', true],
    ['custom-provider', true],
  ] as const)('handles %s providers', (provider, expected) => {
    expect(supportsBackgroundBashModel({ provider } as Model<Api>)).toBe(expected);
  });

  it('waits for a selected model before activation', () => {
    expect(supportsBackgroundBashModel(undefined)).toBe(false);
  });

  it('requires in-process shell support before probing POSIX utilities', async () => {
    const runtime = {
      async shell() { throw new Error('Unexpected POSIX probe'); },
    } as unknown as AgentRuntime;
    await expect(inspectBackgroundBashRuntime(runtime)).resolves.toEqual({
      available: false, reason: 'Runtime does not support in-process shell processes',
    });
  });
});
