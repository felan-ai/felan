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

  it('includes the actual split-turn prefix after saturated historical evidence', async () => {
    const complete = vi.fn().mockResolvedValue(assistantResponse([
      '## Goal', 'Publish results', '## Constraints & Preferences', '(none)',
      '## Progress', 'In progress', '## Key Decisions', 'Filesystem first',
      '## Next Steps', 'Continue publication', '## Critical Context', 'AWS was removed',
      '---', '**Turn Context (split turn):**', '## Original Request', 'Use filesystem storage',
      '## Early Progress', 'Removed AWS', '## Context for Suffix', 'Publication continues',
    ].join('\n')));
    const handlers = install(complete);
    const historicalNoise = Array.from({ length: 48 }, (_, index) => ({
      role: 'toolResult',
      toolCallId: `noise-${index}`,
      toolName: 'unknown_tool',
      isError: false,
      content: [{ type: 'text', text: `historical-noise-${index} ${'x'.repeat(4_096)}` }],
    }));
    const largeToolOutput = `${'routine output\n'.repeat(500)}TOOL_OUTPUT_MIDDLE_SHOULD_BE_OMITTED${'routine output\n'.repeat(500)}final status`;

    await handlers.before({
      preparation: {
        ...prepared(),
        messagesToSummarize: [
          { role: 'user', content: 'Publish a public results archive.' },
          ...historicalNoise,
        ],
        turnPrefixMessages: [
          { role: 'user', content: 'Use the filesystem first; defer Supabase or Vercel.' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'The user correction supersedes the earlier AWS approach.' },
              { type: 'text', text: 'Remove the AWS SDK and S3 adapter before continuing.' },
              { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'src/config.ts' } },
            ],
          },
          {
            role: 'toolResult', toolCallId: 'read-1', toolName: 'read', isError: false,
            content: [{ type: 'text', text: `FILE_BODY_SHOULD_BE_OMITTED\n${largeToolOutput}` }],
          },
          {
            role: 'assistant',
            content: [{
              type: 'toolCall', id: 'patch-1', name: 'apply_patch',
              arguments: { input: `*** Begin Patch\n*** Update File: src/store.ts\n${'PATCH_BODY_SHOULD_BE_OMITTED\n'.repeat(500)}*** End Patch` },
            }],
          },
          {
            role: 'toolResult', toolCallId: 'patch-1', toolName: 'apply_patch', isError: false,
            content: [{ type: 'text', text: 'Patch applied' }],
            details: { status: 'success', result: { changedFiles: ['src/store.ts'] } },
          },
          {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'test-1', name: 'bash', arguments: { command: 'pnpm test' } }],
          },
          {
            role: 'toolResult', toolCallId: 'test-1', toolName: 'bash', isError: false,
            content: [{ type: 'text', text: `18 tests passed\n${largeToolOutput}` }],
          },
        ],
      },
      branchEntries: branch(),
      reason: 'threshold',
      willRetry: false,
      signal: new AbortController().signal,
    });

    expect(complete).toHaveBeenCalledOnce();
    const prompt = complete.mock.calls[0]?.[1].messages[0]?.content[0]?.text;
    expect(prompt).toContain('<split-turn-prefix>');
    expect(prompt).toContain('<split-turn-output-headings>');
    expect(prompt).toContain('Use the filesystem first; defer Supabase or Vercel.');
    expect(prompt).toContain('Remove the AWS SDK and S3 adapter before continuing.');
    expect(prompt).toContain('The user correction supersedes the earlier AWS approach.');
    expect(prompt).toContain('Read src/config.ts');
    expect(prompt).toContain('Patch applied; changed src/store.ts');
    expect(prompt).toContain('18 tests passed');
    expect(prompt).toContain('call=test-1');
    expect(prompt).not.toContain('FILE_BODY_SHOULD_BE_OMITTED');
    expect(prompt).not.toContain('PATCH_BODY_SHOULD_BE_OMITTED');
    expect(prompt).not.toContain('TOOL_OUTPUT_MIDDLE_SHOULD_BE_OMITTED');
    expect(prompt).toContain('[... output omitted ...]');
    expect(prompt).toContain('final status');
    expect(prompt).not.toContain('assistant tool call');
    expect(prompt?.match(/Use the filesystem first; defer Supabase or Vercel\./gu)).toHaveLength(1);
    const orderedFacts = [
      'Use the filesystem first; defer Supabase or Vercel.',
      'The user correction supersedes the earlier AWS approach.',
      'Remove the AWS SDK and S3 adapter before continuing.',
      'Read src/config.ts',
      'Patch applied; changed src/store.ts',
      '18 tests passed',
    ].map((value) => prompt!.indexOf(value));
    expect(orderedFacts).toEqual([...orderedFacts].sort((left, right) => left - right));
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThan(96 * 1_024);
  });

  it('preserves assistant block order around an unmatched tool call', async () => {
    const complete = vi.fn().mockResolvedValue(assistantResponse([
      canonicalSummary(), '---', '**Turn Context (split turn):**', '## Original Request', 'Inspect state',
      '## Early Progress', 'Inspection pending', '## Context for Suffix', 'Continue',
    ].join('\n')));
    const handlers = install(complete);

    await handlers.before({
      preparation: {
        ...prepared(),
        turnPrefixMessages: [{
          role: 'assistant',
          content: [
            { type: 'text', text: 'Before pending inspection.' },
            { type: 'toolCall', id: 'pending-read', name: 'read', arguments: { path: 'src/pending.ts' } },
            { type: 'text', text: 'After pending inspection request.' },
          ],
        }],
      },
      branchEntries: branch(),
      reason: 'threshold',
      willRetry: false,
      signal: new AbortController().signal,
    });

    const prompt = complete.mock.calls[0]?.[1].messages[0]?.content[0]?.text as string;
    const positions = [
      'Before pending inspection.',
      'call=pending-read',
      'After pending inspection request.',
    ].map((value) => prompt.indexOf(value));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('falls through rather than dropping a split-turn test outcome', async () => {
    const complete = vi.fn();
    const handlers = install(complete);

    const result = await handlers.before({
      preparation: {
        ...prepared(),
        turnPrefixMessages: [
          { role: 'user', content: `Required narrative ${'x'.repeat(23 * 1_024)}` },
          {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'test-1', name: 'bash', arguments: { command: 'pnpm test' } }],
          },
          {
            role: 'toolResult', toolCallId: 'test-1', toolName: 'bash', isError: false,
            content: [{ type: 'text', text: `26 tests passed ${'y'.repeat(2_048)}` }],
          },
        ],
      },
      branchEntries: branch(),
      reason: 'threshold',
      willRetry: false,
      signal: new AbortController().signal,
    });

    expect(result).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it('reserves evidence capacity for an early split-turn test outcome', async () => {
    const complete = vi.fn().mockResolvedValue(assistantResponse([
      canonicalSummary(), '---', '**Turn Context (split turn):**', '## Original Request', 'Inspect files',
      '## Early Progress', 'Verification passed', '## Context for Suffix', 'Continue',
    ].join('\n')));
    const handlers = install(complete);
    const readCalls = Array.from({ length: 300 }, (_, index) => ({
      type: 'toolCall', id: `read-${index}`, name: 'read', arguments: { path: `src/file-${index}.ts` },
    }));
    const readResults = Array.from({ length: 300 }, (_, index) => ({
      role: 'toolResult', toolCallId: `read-${index}`, toolName: 'read', isError: false,
      content: [{ type: 'text', text: `file body ${index}` }],
    }));

    await handlers.before({
      preparation: {
        ...prepared(),
        turnPrefixMessages: [
          {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'early-test', name: 'bash', arguments: { command: 'pnpm test' } },
              ...readCalls,
            ],
          },
          {
            role: 'toolResult', toolCallId: 'early-test', toolName: 'bash', isError: false,
            content: [{ type: 'text', text: 'Early verification: 28 tests passed' }],
          },
          ...readResults,
        ],
      },
      branchEntries: branch(),
      reason: 'threshold',
      willRetry: false,
      signal: new AbortController().signal,
    });

    expect(complete).toHaveBeenCalledOnce();
    const prompt = complete.mock.calls[0]?.[1].messages[0]?.content[0]?.text;
    expect(prompt).toContain('Early verification: 28 tests passed');
    expect(prompt).toContain('call=early-test');
  });

  it('reserves preparation capacity for a split prefix after saturated history', async () => {
    const complete = vi.fn().mockResolvedValue(assistantResponse([
      canonicalSummary(), '---', '**Turn Context (split turn):**', '## Original Request', 'Keep this request',
      '## Early Progress', 'None', '## Context for Suffix', 'Continue',
    ].join('\n')));
    const handlers = install(complete);

    await handlers.before({
      preparation: {
        ...prepared(),
        messagesToSummarize: Array.from({ length: 600 }, (_, index) => ({
          role: 'user', content: `Historical message ${index}`,
        })),
        turnPrefixMessages: [{ role: 'user', content: 'Keep this split-prefix request.' }],
      },
      branchEntries: branch(),
      reason: 'threshold',
      willRetry: false,
      signal: new AbortController().signal,
    });

    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[1].messages[0]?.content[0]?.text).toContain('Keep this split-prefix request.');
  });

  it('falls through before generation when required split-turn narrative cannot fit', async () => {
    const complete = vi.fn();
    const handlers = install(complete);

    const result = await handlers.before({
      preparation: {
        ...prepared(),
        turnPrefixMessages: [{ role: 'user', content: `Required request ${'x'.repeat(24 * 1_024)}` }],
      },
      branchEntries: branch(),
      reason: 'threshold',
      willRetry: false,
      signal: new AbortController().signal,
    });

    expect(result).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
    expect(handlers.diagnostics).toHaveLength(1);
    expect(handlers.notifications).toHaveLength(1);
    const notification = handlers.notifications[0] as { message: string; type: string };
    expect(notification).toMatchObject({ type: 'warning' });
    expect(notification.message).toContain('Pi native compaction');
  });

  it('falls through before prompt construction when a previous summary exceeds its bound', async () => {
    const complete = vi.fn();
    const handlers = install(complete);

    const result = await handlers.before({
      preparation: {
        ...prepared(),
        previousSummary: `Previous summary ${'x'.repeat(24 * 1_024)}`,
      },
      branchEntries: branch(),
      reason: 'threshold',
      willRetry: false,
      signal: new AbortController().signal,
    });

    expect(result).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
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
    expect(handlers.diagnostics).toHaveLength(1);
    expect(handlers.diagnostics[0]).toMatchObject({ reason: 'model-response-invalid', stopReason: 'length' });
    expect(handlers.notifications).toHaveLength(1);
  });

  it('records bounded model request errors before native fallback', async () => {
    const complete = vi.fn().mockRejectedValue(new Error(`provider failed: ${'x'.repeat(10_000)} Bearer secret`));
    const handlers = install(complete);

    await expect(handlers.before({
      preparation: prepared(),
      branchEntries: branch(),
      reason: 'threshold',
      willRetry: false,
      signal: new AbortController().signal,
    })).resolves.toBeUndefined();

    expect(handlers.diagnostics).toHaveLength(1);
    expect(handlers.diagnostics[0]).toMatchObject({ reason: 'model-request-failed' });
    expect(JSON.stringify(handlers.diagnostics[0])).not.toContain('Bearer secret');
    expect(handlers.notifications).toHaveLength(1);
  });

  it('falls through instead of cancelling when only the extension timeout aborts', async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const complete = vi.fn().mockImplementation(async () => {
      timeout.abort();
      return assistantResponse(canonicalSummary());
    });
    const handlers = install(complete);

    try {
      await expect(handlers.before({
        preparation: prepared(),
        branchEntries: branch(),
        reason: 'threshold',
        willRetry: false,
        signal: new AbortController().signal,
      })).resolves.toBeUndefined();
    } finally {
      timeoutSpy.mockRestore();
    }
    expect(handlers.diagnostics).toHaveLength(1);
    expect(handlers.diagnostics[0]).toMatchObject({ reason: 'model-timeout' });
    expect(handlers.notifications).toHaveLength(1);
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
    expect(handlers.diagnostics).toHaveLength(0);
    expect(handlers.notifications).toHaveLength(0);
  });

  it.each([
    ['xhigh', 'claude-fable-5'],
    ['high', 'claude-opus-5'],
    ['medium', 'claude-sonnet-5'],
    ['low', 'claude-haiku-4-5'],
  ] as const)('selects the configured %s tier', async (tier, id) => {
    const complete = vi.fn().mockResolvedValue(assistantResponse(canonicalSummary()));
    const handlers = install(complete, { model: tier }, [{ provider: 'anthropic', id, input: ['text'], maxTokens: 1_000, reasoning: true }]);
    const result = await handlers.before({
      preparation: prepared(), branchEntries: branch(), reason: 'manual', willRetry: false,
      signal: new AbortController().signal,
    });
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ provider: 'anthropic', id });
    expect(result).toMatchObject({ compaction: { details: { requestedModel: tier, selectedModel: `anthropic/${id}` } } });
  });

  it('falls back to inherit when a configured tier is unavailable', async () => {
    const complete = vi.fn().mockResolvedValue(assistantResponse(canonicalSummary()));
    const handlers = install(complete, { model: 'low' });
    const result = await handlers.before({
      preparation: prepared(), branchEntries: branch(), reason: 'manual', willRetry: false,
      signal: new AbortController().signal,
    });
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ provider: 'test', id: 'model' });
    expect(result).toMatchObject({ compaction: { details: { requestedModel: 'low', modelFallback: 'inherit' } } });
  });

  it('prefers the active model family and honors the configured session scope', async () => {
    const complete = vi.fn().mockResolvedValue(assistantResponse(canonicalSummary()));
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
  const diagnostics: unknown[] = [];
  const notifications: unknown[] = [];
  const model = { provider: 'test', id: 'model', maxTokens: 4_096 };
  const pi = {
    config,
    on: (name: string, handler: (...args: any[]) => any) => registered.set(name, handler),
    appendEntry: (_type: string, data: unknown) => { diagnostics.push(data); },
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
    ui: { notify: (message: string, type: string) => { notifications.push({ message, type }); } },
  } as any;
  return {
    before: (event: any) => registered.get('session_before_compact')!(event, ctx),
    diagnostics,
    notifications,
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

function canonicalSummary(): string {
  return [
    '## Goal', 'G', '## Constraints & Preferences', '(none)', '## Progress', 'P',
    '## Key Decisions', 'None', '## Next Steps', 'N', '## Critical Context', 'None',
  ].join('\n');
}
