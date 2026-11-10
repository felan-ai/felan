import type { AgentRuntime, Api, Model } from '@felan-ai/agent-core';
import { describe, expect, it } from 'vitest';
import { inspectBackgroundBashRuntime, supportsBackgroundBashModel } from '../src/index.js';

describe('background bash model policy', () => {
  it('requires a selected model without restricting its provider', () => {
    expect(supportsBackgroundBashModel(undefined)).toBe(false);
    expect(supportsBackgroundBashModel({ provider: 'custom-provider' } as Model<Api>)).toBe(true);
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
