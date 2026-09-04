import type { AssistantMessage, ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { createOutputStyleExtension } from '../src/index.js';

describe('output-style savings', () => {
  it('reports the concise visible-text boundary with the retained Terra-v2 ratio', async () => {
    const harness = savingsHarness('concise');

    await harness.turn(assistant('abcdefgh'));

    expect(harness.report).toHaveBeenCalledWith(expect.objectContaining({
      category: 'output-optimization',
      operation: 'concise-response',
      baseline: { model: { provider: 'test', id: 'model' }, tokens: { input: 0, output: 3 } },
      actual: { model: { provider: 'test', id: 'model' }, tokens: { input: 0, output: 2 } },
      basis: {
        kind: 'estimated-baseline',
        method: 'concise-visible-text-ratio-terra-v2-20260827-v1',
      },
      dimensions: { techniques: ['concise'] },
    }));
  });

  it.each(['explanatory', 'custom'] as const)('does not assign savings to %s', async (style) => {
    const harness = savingsHarness(style, style === 'custom' ? 'Custom response rules.' : undefined);

    await harness.turn(assistant('visible response'));

    expect(harness.report).not.toHaveBeenCalled();
  });

  it('excludes empty, failed, aborted, and unattributed turns and keeps reporter failures fail-open', async () => {
    const harness = savingsHarness('concise', undefined, true);

    await expect(harness.turn(assistant('visible response'))).resolves.toBeUndefined();
    await harness.turn(assistant(''));
    await harness.turn(assistant('failed', 'error'));
    await harness.turn(assistant('aborted', 'aborted'));
    await harness.turn(assistant('missing model'), null);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(harness.report).toHaveBeenCalledOnce();
  });

  it('keeps synchronous reporter failures fail-open', async () => {
    const harness = savingsHarness('concise', undefined, false, true);

    await expect(harness.turn(assistant('visible response'))).resolves.toBeUndefined();
    expect(harness.report).toHaveBeenCalledOnce();
  });
});

function savingsHarness(
  style: 'concise' | 'explanatory' | 'custom',
  instructions?: string,
  reject = false,
  throwSynchronously = false,
) {
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const report = vi.fn(() => {
    if (throwSynchronously) throw new Error('unavailable');
    if (reject) return Promise.reject(new Error('unavailable'));
    return Promise.resolve();
  });
  createOutputStyleExtension(style, instructions)({
    savings: { report },
    on: ((event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    }) as FelanExtensionAPI['on'],
  } as unknown as FelanExtensionAPI);
  return {
    report,
    async turn(
      message: AssistantMessage,
      model: ExtensionContext['model'] | null = { provider: 'test', id: 'model' } as any,
    ) {
      for (const handler of handlers.get('turn_end') ?? []) {
        await handler(
          { message, toolResults: [], turnIndex: 0 },
          (model === null ? {} : { model }) as ExtensionContext,
        );
      }
    },
  };
}

function assistant(text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    api: 'test',
    provider: 'test',
    model: 'model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}
