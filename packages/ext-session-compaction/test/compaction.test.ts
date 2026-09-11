import { describe, expect, it, vi } from 'vitest';
import type { FelanExtensionAPI } from '@felan-ai/agent-core';
import { createSessionCompactionExtension } from '../src/compaction.js';

describe('verified session compaction', () => {
  it('uses one active-model request and preserves Pi cut metadata', async () => {
    const complete = vi.fn().mockResolvedValue(assistantResponse([
      '## Goal', 'Fix login', '## Constraints & Preferences', '- Run tests',
      '## Progress', 'Done', '## Key Decisions', 'None', '## Next Steps', 'Run tests', '## Critical Context', 'None',
    ].join('\n')));
    const handlers = install(complete);
    const preparation = prepared();
    const result = await handlers.before({
      preparation,
      branchEntries: branch(),
      reason: 'manual',
      willRetry: false,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      compaction: {
        firstKeptEntryId: 'keep-1',
        tokensBefore: 100,
        details: {
          namespace: 'felan.session-compaction',
          schemaVersion: 1,
          attemptId: expect.any(String),
        },
      },
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[1].messages[0]?.content[0]?.text).toContain('<historical-evidence>');
  });

  it('falls through to native compaction for an incomplete model response', async () => {
    const complete = vi.fn().mockResolvedValue(assistantResponse('## Goal\npartial', 'length'));
    const handlers = install(complete);
    await expect(handlers.before({
      preparation: prepared(),
      branchEntries: branch(),
      reason: 'threshold',
      willRetry: false,
      signal: new AbortController().signal,
    })).resolves.toBeUndefined();
  });

  it('keeps user cancellation as cancellation instead of falling through', async () => {
    const controller = new AbortController();
    controller.abort();
    const handlers = install(vi.fn());
    await expect(handlers.before({
      preparation: prepared(),
      branchEntries: branch(),
      reason: 'overflow',
      willRetry: true,
      signal: controller.signal,
    })).resolves.toEqual({ cancel: true });
  });

  it.each([
    ['xhigh', 'claude-fable-5'],
    ['high', 'claude-opus-5'],
    ['medium', 'claude-sonnet-5'],
    ['low', 'claude-haiku-4-5'],
  ] as const)('selects the configured %s tier', async (tier, id) => {
    const complete = vi.fn().mockResolvedValue(assistantResponse('## Goal\nG\n## Progress\nP\n## Next Steps\nN'));
    const handlers = install(complete, { model: tier }, [{ provider: 'anthropic', id, input: ['text'], maxTokens: 1_000, reasoning: true }]);
    const result = await handlers.before({
      preparation: prepared(), branchEntries: branch(), reason: 'manual', willRetry: false,
      signal: new AbortController().signal,
    });
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ provider: 'anthropic', id });
    expect(result).toMatchObject({ compaction: { details: { requestedModel: tier, selectedModel: `anthropic/${id}` } } });
  });

  it('falls back to inherit when a configured tier is unavailable', async () => {
    const complete = vi.fn().mockResolvedValue(assistantResponse('## Goal\nG\n## Progress\nP\n## Next Steps\nN'));
    const handlers = install(complete, { model: 'low' });
    const result = await handlers.before({
      preparation: prepared(), branchEntries: branch(), reason: 'manual', willRetry: false,
      signal: new AbortController().signal,
    });
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ provider: 'test', id: 'model' });
    expect(result).toMatchObject({ compaction: { details: { requestedModel: 'low', modelFallback: 'inherit' } } });
  });

  it('prefers the active model family and honors the configured session scope', async () => {
    const complete = vi.fn().mockResolvedValue(assistantResponse('## Goal\nG\n## Progress\nP\n## Next Steps\nN'));
    const handlers = install(complete, { model: 'low' }, [
      { provider: 'openai', id: 'gpt-5-luna', input: ['text'], maxTokens: 1_000, reasoning: true },
      { provider: 'anthropic', id: 'claude-haiku-4-5', input: ['text'], maxTokens: 1_000, reasoning: true },
    ], [{ model: { provider: 'openai', id: 'gpt-5-luna', input: ['text'], maxTokens: 1_000, reasoning: true } }]);
    await handlers.before({
      preparation: prepared(), branchEntries: branch(), reason: 'manual', willRetry: false,
      signal: new AbortController().signal,
    });
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ provider: 'openai', id: 'gpt-5-luna' });
  });
});

function install(
  complete: ReturnType<typeof vi.fn>,
  config: Record<string, unknown> = {},
  available: readonly Record<string, unknown>[] = [],
  scopedModels: readonly Record<string, unknown>[] = [],
) {
  const registered = new Map<string, (...args: any[]) => any>();
  const model = { provider: 'test', id: 'model', maxTokens: 4_096 };
  const pi = {
    config,
    on: (name: string, handler: (...args: any[]) => any) => registered.set(name, handler),
  } as unknown as FelanExtensionAPI;
  createSessionCompactionExtension()(pi);
  const ctx = {
    model,
    thinkingLevel: 'off',
    scopedModels,
    modelRegistry: { complete: complete as any, getAvailable: () => available },
    sessionManager: {
      getSessionId: () => 'session-1',
      getBranch: () => branch(),
    },
  } as any;
  return {
    before: (event: any) => registered.get('session_before_compact')!(event, ctx),
  };
}

function prepared() {
  return {
    firstKeptEntryId: 'keep-1',
    tokensBefore: 100,
    messagesToSummarize: [{ role: 'user', content: 'Fix login. Always run tests.' }],
    turnPrefixMessages: [],
    fileOps: {},
    settings: {},
  } as any;
}

function branch() {
  return [{ type: 'message', id: 'entry-1', parentId: null, timestamp: '', message: { role: 'user', content: 'Fix login' } }];
}

function assistantResponse(text: string, stopReason = 'stop'): any {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'test',
    provider: 'test',
    model: 'model',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  };
}
