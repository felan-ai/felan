import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, type FelanExtensionAPI, type LogRecord } from '@felan-ai/agent-core';
import { createSessionCompactionExtension } from '../src/compaction.js';
import * as continuity from '../src/internal/continuity.js';
import * as extraction from '../src/internal/evidence.js';
import * as splitPrefix from '../src/internal/split-prefix.js';
import * as pruning from '../src/prune.js';

describe('verified session compaction', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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
          method: 'summary',
        },
      },
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[1].messages[0]?.content[0]?.text).toContain('<historical-evidence>');
  });

  describe('summary request timeout', () => {
    it.each([
      ['default', {}, 300_000],
      ['HTTP idle timeout', { httpIdleTimeoutMs: 45_000 }, 45_000],
      ['provider override', { httpIdleTimeoutMs: 45_000, retry: { provider: { timeoutMs: 12_000 } } }, 12_000],
      ['provider override with idle timeout disabled', { httpIdleTimeoutMs: 'disabled', retry: { provider: { timeoutMs: 12_000 } } }, 12_000],
      ['zero idle timeout', { httpIdleTimeoutMs: 0 }, undefined],
      ['disabled idle timeout', { httpIdleTimeoutMs: 'disabled' }, undefined],
      ['zero provider timeout', { httpIdleTimeoutMs: 45_000, retry: { provider: { timeoutMs: 0 } } }, undefined],
      ['negative idle timeout', { httpIdleTimeoutMs: -1 }, undefined],
      ['non-finite idle timeout', { httpIdleTimeoutMs: Infinity }, undefined],
      ['non-finite provider timeout', { httpIdleTimeoutMs: 45_000, retry: { provider: { timeoutMs: NaN } } }, undefined],
    ])('inherits %s', async (_name, settings, expected) => {
      const complete = vi.fn().mockResolvedValue(assistantResponse(canonicalSummary()));
      const handlers = install(complete);
      vi.spyOn(handlers.pi, 'getSettings').mockReturnValue(settings as ReturnType<FelanExtensionAPI['getSettings']>);
      const entries = branch();

      const result = await handlers.before(compactionEvent(entries));

      expect(result.compaction.details.method).toBe('summary');
      expect(complete).toHaveBeenCalledOnce();
      const options = complete.mock.calls[0]?.[2];
      if (expected === undefined) expect(options).not.toHaveProperty('timeoutMs');
      else expect(options).toHaveProperty('timeoutMs', expected);
    });

    it('tolerates unavailable settings without imposing a timeout', async () => {
      const complete = vi.fn().mockResolvedValue(assistantResponse(canonicalSummary()));
      const handlers = install(complete);
      vi.spyOn(handlers.pi, 'getSettings').mockImplementation(() => { throw new Error('settings unavailable'); });
      const entries = branch();

      await expect(handlers.before(compactionEvent(entries))).resolves.toHaveProperty('compaction');
      expect(complete).toHaveBeenCalledOnce();
      expect(complete.mock.calls[0]?.[2]).not.toHaveProperty('timeoutMs');
    });
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

  it('accepts a large split-turn test outcome without dropping it', async () => {
    const complete = vi.fn().mockResolvedValue(assistantResponse(canonicalSummary()));
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

    expect(result?.compaction.summary).toContain('## Goal');
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[1].messages[0]?.content[0]?.text).toContain('26 tests passed');
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

  it('accepts a large required split-turn narrative within the evidence boundary', async () => {
    const complete = vi.fn().mockResolvedValue(assistantResponse(canonicalSummary()));
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

    expect(result?.compaction.summary).toContain('## Goal');
    expect(complete).toHaveBeenCalledOnce();
  });

  it('accepts a previous summary larger than the removed result bound', async () => {
    const complete = vi.fn().mockResolvedValue(assistantResponse(canonicalSummary()));
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

    expect(result?.compaction.summary).toContain('## Goal');
    expect(complete).toHaveBeenCalledOnce();
  });

  it('uses verified summary when classifier compaction is configured without a classifier', async () => {
    const complete = vi.fn().mockResolvedValue(assistantResponse(canonicalSummary()));
    const handlers = install(complete, { method: 'classifier' });
    const result = await handlers.before({
      preparation: prepared(), branchEntries: branch(), reason: 'manual', willRetry: false,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ compaction: { details: { method: 'summary' } } });
    expect(complete).toHaveBeenCalledOnce();
    expect(handlers.diagnostics).toHaveLength(0);
  });

  it.each([undefined, null, 'unknown'])('uses a verified summary for method %j even with a classifier', async (method) => {
    const complete = vi.fn().mockResolvedValue(assistantResponse(canonicalSummary()));
    const classify = vi.fn(async () => ({ answers: {} }));
    const handlers = install(complete, { method }, [], [], { classify });
    await expect(handlers.before({
      preparation: classifierPreparation(), branchEntries: branch(), reason: 'manual', willRetry: false,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ compaction: { details: { method: 'summary' } } });
    expect(classify).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
  });

  it('accepts a non-empty summary that omits canonical headings instead of paying for native fallback', async () => {
    const complete = vi.fn().mockResolvedValue(assistantResponse('Continue the login fix. Run tests next.'));
    const handlers = install(complete);
    const result = await handlers.before({
      preparation: prepared(),
      branchEntries: branch(),
      reason: 'manual',
      willRetry: false,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      compaction: {
        summary: expect.stringContaining('Continue the login fix. Run tests next.'),
        details: { namespace: 'felan.session-compaction' },
      },
    });
    expect(handlers.diagnostics).toHaveLength(0);
  });

  it('accepts a summary larger than 24 KiB', async () => {
    const complete = vi.fn().mockResolvedValue(assistantResponse(`## Goal\n${'x'.repeat(25 * 1_024)}`));
    const handlers = install(complete);
    const result = await handlers.before({
      preparation: prepared(),
      branchEntries: branch(),
      reason: 'manual',
      willRetry: false,
      signal: new AbortController().signal,
    });
    expect(result?.compaction.summary.length).toBeGreaterThan(24 * 1_024);
    expect(handlers.diagnostics).toHaveLength(0);
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

  it('prunes successful tool observations with an injected classifier', async () => {
    const complete = vi.fn();
    const classify = vi.fn(async (_state: unknown, questions: Record<string, unknown>) => ({
      answers: Object.fromEntries(
        Object.keys(questions).map((name) => [name, {
          type: 'choice' as const,
          choice: 'obsolete' as const,
          probabilities: { exact_contents: 0.05, outcome_only: 0.1, obsolete: 0.85 },
          confidence: 0.8,
        }]),
      ),
    }));
    const handlers = install(complete, { method: 'classifier' }, [], [], { classify });
    const result = await handlers.before({
      preparation: {
        ...prepared(),
        messagesToSummarize: [
          { role: 'user', content: 'Fix login. Always run tests.' },
          {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'call-1', name: 'unknown_tool', arguments: {} }],
          },
          {
            role: 'toolResult', toolCallId: 'call-1', toolName: 'unknown_tool', isError: false,
            content: [{ type: 'text', text: `OBSOLETE_TOOL_OUTPUT ${'x'.repeat(120)}` }],
          },
        ],
      },
      branchEntries: branch(),
      reason: 'manual',
      willRetry: false,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ compaction: { details: { method: 'classifier', prune: { status: 'ran', dropped: 1 } } } });
    expect(result?.compaction.summary).not.toContain('OBSOLETE_TOOL_OUTPUT');
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not call the runtime classifier in summary mode', async () => {
    const complete = vi.fn().mockResolvedValue(assistantResponse(canonicalSummary()));
    const classify = vi.fn(async () => ({ answers: {} }));
    const handlers = install(complete, { method: 'summary' }, [], [], { classify });

    const result = await handlers.before({
      preparation: prepared(), branchEntries: branch(), reason: 'manual', willRetry: false,
      signal: new AbortController().signal,
    });

    expect(classify).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ compaction: { details: { method: 'summary' } } });
  });

  it('accepts a classifier transcript larger than 24 KiB', async () => {
    const complete = vi.fn();
    const classify = vi.fn(async (_state: unknown, questions: Record<string, unknown>) => ({
      answers: Object.fromEntries(Object.keys(questions).map((id) => [id, {
        type: 'choice' as const,
        choice: 'outcome_only',
        probabilities: { exact_contents: 0.05, outcome_only: 0.9, obsolete: 0.05 },
        confidence: 0.9,
      }])),
    }));
    const handlers = install(complete, { method: 'classifier' }, [], [], { classify });
    const messages = [{ role: 'user', content: 'Review the results.' }];
    for (let index = 0; index < 100; index += 1) {
      messages.push(
        { role: 'assistant', content: [{ type: 'toolCall', id: `call-${index}`, name: 'grep', arguments: {} }] } as never,
        { role: 'toolResult', toolCallId: `call-${index}`, toolName: 'grep', isError: false, content: [{ type: 'text', text: `result-${index} ${'x'.repeat(400)}` }] } as never,
      );
    }
    const result = await handlers.before({
      preparation: { ...prepared(), messagesToSummarize: messages },
      branchEntries: branch(), reason: 'manual', willRetry: false,
      signal: new AbortController().signal,
    });
    expect(result?.compaction.summary.length).toBeGreaterThan(24 * 1_024);
    expect(result?.compaction.details).toMatchObject({ method: 'classifier', prune: { status: 'ran', asked: expect.any(Number) } });
    expect((result?.compaction.details as any).prune.asked).toBeGreaterThan(64);
    expect(complete).not.toHaveBeenCalled();
  });

  it('falls back to verified summary when the classifier fails', async () => {
    const complete = vi.fn().mockResolvedValue(assistantResponse(canonicalSummary()));
    const classify = vi.fn().mockRejectedValue(new Error('classifier unavailable'));
    const handlers = install(complete, { method: 'classifier', model: 'low' }, [
      { provider: 'anthropic', id: 'claude-haiku-4-5', input: ['text'], maxTokens: 1_000, reasoning: true },
    ], [], { classify });

    const result = await handlers.before({
      preparation: classifierPreparation(),
      branchEntries: branch(), reason: 'manual', willRetry: false,
      signal: new AbortController().signal,
    });

    expect(classify).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ provider: 'anthropic', id: 'claude-haiku-4-5' });
    expect(complete.mock.calls[0]?.[1].messages[0]?.content[0]?.text).toContain('CLASSIFIER_FAILURE_OUTPUT');
    expect(result).toMatchObject({ compaction: { details: {
      method: 'summary',
      requestedModel: 'low',
      prune: { status: 'skipped', reason: 'classifier-failed' },
    } } });
    expect(handlers.diagnostics).toHaveLength(0);
    expect(handlers.notifications).toHaveLength(0);
    expect(handlers.logs.filter(({ level }) => level === 'warn')).toEqual([expect.objectContaining({
      msg: 'session compaction classifier failed; trying verified summary',
      fields: expect.objectContaining({ component: 'session-compaction', sessionId: 'session-1' }),
    })]);
  });

  it('sanitizes classifier errors in both debug and warning logs', async () => {
    const complete = vi.fn().mockResolvedValue(assistantResponse(canonicalSummary()));
    const classify = vi.fn().mockRejectedValue(new Error(
      `classifier failed: api_key\u0000=secret-value Bearer\u0000 bearer-secret ${'界'.repeat(2_000)}`,
    ));
    const handlers = install(complete, { method: 'classifier' }, [], [], { classify });

    await handlers.before({
      preparation: classifierPreparation(),
      branchEntries: branch(), reason: 'manual', willRetry: false,
      signal: new AbortController().signal,
    });

    expect(handlers.logs.filter(({ level }) => level !== 'info')).toEqual([
      expect.objectContaining({
        level: 'debug',
        msg: 'session compaction prune',
        fields: expect.objectContaining({
          trigger: 'manual', candidates: 1, bulky: 1,
          report: { status: 'skipped', reason: 'classifier-failed' },
          state: expect.any(Object), questions: expect.any(Object), error: expect.any(String),
        }),
      }),
      expect.objectContaining({
        level: 'warn',
        msg: 'session compaction classifier failed; trying verified summary',
        fields: expect.objectContaining({ errorMessage: expect.any(String) }),
      }),
    ]);
    for (const error of [handlers.logs[0]?.fields.error, handlers.logs[1]?.fields.errorMessage]) {
      expect(error).toContain('api_key=[redacted] Bearer [redacted]');
      expect(error).not.toContain('secret-value');
      expect(error).not.toContain('bearer-secret');
      expect(error).not.toContain('\u0000');
      expect(new TextEncoder().encode(error as string).byteLength).toBeLessThanOrEqual(1_024);
    }
  });

  it.each([
    ['evidence extraction', () => vi.spyOn(extraction, 'extractEvidence')],
    ['split-prefix rendering', () => vi.spyOn(splitPrefix, 'renderSplitTurnPrefix')],
    ['compaction details', () => vi.spyOn(continuity, 'createCompactionDetails')],
  ] as const)('does not misclassify %s errors as classifier failures', async (_name, spy) => {
    const error = new Error('preparation failed');
    const failure = spy().mockImplementationOnce(() => { throw error; });
    try {
      const complete = vi.fn().mockResolvedValue(assistantResponse(canonicalSummary()));
      const handlers = install(complete, { method: 'classifier' }, [], [], { classify: vi.fn() });

      await expect(handlers.before({
        preparation: {
          ...prepared(),
          turnPrefixMessages: [{ role: 'user', content: 'Keep the current request.' }],
        },
        branchEntries: branch(), reason: 'manual', willRetry: false,
        signal: new AbortController().signal,
      })).rejects.toBe(error);

      expect(complete).not.toHaveBeenCalled();
      expect(handlers.diagnostics).toHaveLength(0);
      expect(handlers.logs.filter(({ level }) => level === 'warn')).toHaveLength(0);
    } finally {
      failure.mockRestore();
    }
  });

  it('delegates an oversized classifier split-prefix directly to native compaction', async () => {
    const complete = vi.fn();
    const handlers = install(complete, { method: 'classifier' }, [], [], { classify: vi.fn() });

    await expect(handlers.before({
      preparation: {
        ...prepared(),
        turnPrefixMessages: [{ role: 'user', content: 'x'.repeat(65 * 1_024) }],
      },
      branchEntries: branch(), reason: 'manual', willRetry: false,
      signal: new AbortController().signal,
    })).resolves.toBeUndefined();

    expect(complete).not.toHaveBeenCalled();
    expect(handlers.diagnostics).toEqual([expect.objectContaining({ reason: 'prompt-preparation-failed' })]);
    expect(handlers.logs.filter(({ level }) => level === 'warn')).toHaveLength(0);
  });

  it('falls back to native compaction only after classifier and summary requests fail', async () => {
    const complete = vi.fn().mockRejectedValue(new Error('summary unavailable'));
    const classify = vi.fn().mockRejectedValue(new Error('classifier unavailable'));
    const handlers = install(complete, { method: 'classifier' }, [], [], { classify });

    await expect(handlers.before({
      preparation: classifierPreparation(),
      branchEntries: branch(), reason: 'manual', willRetry: false,
      signal: new AbortController().signal,
    })).resolves.toBeUndefined();

    expect(classify).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(handlers.diagnostics).toHaveLength(1);
    expect(handlers.diagnostics[0]).toMatchObject({
      reason: 'model-request-failed',
      errorMessage: 'summary unavailable',
      prune: { status: 'skipped', reason: 'classifier-failed' },
    });
    expect(handlers.notifications).toHaveLength(1);
  });

  it('cancels without a summary request when the classifier rejects after abort', async () => {
    const controller = new AbortController();
    const complete = vi.fn();
    const classify = vi.fn(async () => {
      controller.abort();
      throw new Error('classifier aborted');
    });
    const handlers = install(complete, { method: 'classifier' }, [], [], { classify });

    await expect(handlers.before({
      preparation: classifierPreparation(),
      branchEntries: branch(), reason: 'manual', willRetry: false,
      signal: controller.signal,
    })).resolves.toEqual({ cancel: true });

    expect(classify).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(handlers.diagnostics).toHaveLength(0);
    expect(handlers.notifications).toHaveLength(0);
    expect(handlers.logs).toHaveLength(0);
  });

  it('uses verified summary and logs a bounded sanitized error when pruning throws', async () => {
    const prune = vi.spyOn(pruning, 'pruneEvidence').mockRejectedValueOnce(
      new Error(`classifier failed: api_key\u0000=secret-value Bearer\u0000 bearer-secret ${'x'.repeat(2_000)}`),
    );
    try {
      const complete = vi.fn().mockResolvedValue(assistantResponse(canonicalSummary()));
      const handlers = install(complete, { method: 'classifier' }, [], [], { classify: vi.fn() });

      const result = await handlers.before({
        preparation: classifierPreparation(),
        branchEntries: branch(), reason: 'manual', willRetry: false,
        signal: new AbortController().signal,
      });

      expect(complete).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ compaction: { details: {
        method: 'summary',
        prune: { status: 'skipped', reason: 'classifier-failed' },
      } } });
      expect(handlers.diagnostics).toHaveLength(0);
      expect(handlers.notifications).toHaveLength(0);
      expect(handlers.logs.filter(({ level }) => level !== 'info')).toEqual([expect.objectContaining({
        level: 'warn',
        msg: 'session compaction classifier failed; trying verified summary',
        fields: expect.objectContaining({
          component: 'session-compaction', sessionId: 'session-1', errorMessage: expect.any(String),
        }),
      })]);
      const errorMessage = handlers.logs[0]?.fields.errorMessage as string;
      expect(errorMessage).toContain('classifier failed: api_key=[redacted] Bearer [redacted]');
      expect(errorMessage).not.toContain('secret');
      expect(errorMessage).not.toContain('\u0000');
      expect(new TextEncoder().encode(errorMessage).byteLength).toBeLessThanOrEqual(1_024);
    } finally {
      prune.mockRestore();
    }
  });

  it('logs classifier debug without putting it on the compaction entry', async () => {
    const complete = vi.fn();
    const classify = vi.fn(async () => ({ answers: {} }));
    const handlers = install(complete, { method: 'classifier' }, [], [], { classify });
    const result = await handlers.before({
      preparation: prepared(), branchEntries: branch(), reason: 'manual', willRetry: false,
      signal: new AbortController().signal,
    });
    expect(handlers.logs).toEqual([expect.objectContaining({
      level: 'debug',
      msg: 'session compaction prune',
      fields: expect.objectContaining({
        component: 'session-compaction',
        sessionId: 'session-1',
        report: { status: 'skipped', reason: 'no-candidates' },
      }),
    })]);
    expect(result).toMatchObject({
      compaction: { details: { method: 'classifier', prune: { status: 'skipped', reason: 'no-candidates' } } },
    });
    expect(JSON.stringify(result)).not.toContain('leftovers');
  });

  it('accepts a summary with bounded merged file lists, usage, and request telemetry', async () => {
    vi.useFakeTimers();
    const response = assistantResponse(`${canonicalSummary()}\n<read-files>invented.ts</read-files>\n<modified-files>invented.ts</modified-files>`);
    response.usage = {
      input: 10, cacheRead: 200, cacheWrite: 90, output: 5, totalTokens: 305,
      cost: { input: 0.01, cacheRead: 0.02, cacheWrite: 0.03, output: 0.04, total: 0.1 },
    };
    const complete = vi.fn<(...args: any[]) => Promise<any>>(async () => {
      vi.advanceTimersByTime(25);
      return response;
    });
    const handlers = install(complete);
    const entries = [{ type: 'compaction', id: 'previous', details: {
      readFiles: ['prior.ts', 'changed.ts'], modifiedFiles: ['old.ts'],
    } }, ...branch()];
    const result = await handlers.before({
      ...compactionEvent(entries),
      preparation: { ...prepared(), fileOps: { read: new Set(['read.ts', 'changed.ts']), written: new Set(['changed.ts']) } },
    });

    expect(result).toMatchObject({ compaction: {
      usage: response.usage,
      details: { method: 'summary', readFiles: ['prior.ts', 'read.ts'], modifiedFiles: ['changed.ts', 'old.ts'] },
    } });
    expect(result.compaction.summary).toContain('<read-files>\nprior.ts\nread.ts\n</read-files>');
    expect(result.compaction.summary).toContain('<modified-files>\nchanged.ts\nold.ts\n</modified-files>');
    expect(result.compaction.summary).not.toContain('invented.ts');
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[2]).toMatchObject({ maxTokens: 4_096, sessionId: result.compaction.details.attemptId, cacheRetention: 'none' });
    expect(handlers.logs).toEqual([expect.objectContaining({
      level: 'info', msg: 'session compaction request', fields: {
        component: 'session-compaction', sessionId: 'session-1', method: 'summary',
        trigger: 'manual', model: 'test/model', latencyMs: 25,
        outcome: 'accepted', usage: { input: 10, cacheRead: 200, cacheWrite: 90, output: 5, cost: 0.1 }, cacheShare: 0.667,
      },
    })]);
  });

  it.each(['summary', 'classifier'] as const)('appends only collected file lists to the %s path', async (method) => {
    const complete = vi.fn().mockResolvedValue(assistantResponse(`${canonicalSummary()}\n<read-files>invented.ts</read-files>`));
    const handlers = install(complete, { method }, [], [], { classify: vi.fn() });
    const result = await handlers.before({
      ...compactionEvent(),
      preparation: { ...prepared(), previousSummary: '<modified-files>stale.ts</modified-files>', fileOps: {
        read: new Set(['read.ts', 'modified.ts']), edited: new Set(['modified.ts']),
      } },
    });
    expect(result.compaction.summary).toContain('<read-files>\nread.ts\n</read-files>');
    expect(result.compaction.summary).toContain('<modified-files>\nmodified.ts\n</modified-files>');
    expect(result.compaction.summary).not.toContain('invented.ts');
    expect(result.compaction.summary).not.toContain('stale.ts');
    expect(result.compaction.details).toMatchObject({ readFiles: ['read.ts'], modifiedFiles: ['modified.ts'] });
    expect(complete).toHaveBeenCalledTimes(method === 'summary' ? 1 : 0);
  });

  it('logs fresh latency and omits the cache share for zero input', async () => {
    vi.useFakeTimers();
    const response = assistantResponse(canonicalSummary());
    response.usage = { ...response.usage, input: 0 };
    const complete = vi.fn(async () => { vi.advanceTimersByTime(37); return response; });
    const handlers = install(complete);
    const result = await handlers.before(compactionEvent());
    expect(result.compaction.details).not.toHaveProperty('readFiles');
    expect(result.compaction.details).not.toHaveProperty('modifiedFiles');
    expect(handlers.logs).toEqual([expect.objectContaining({
      level: 'info', msg: 'session compaction request', fields: expect.objectContaining({
        latencyMs: 37, outcome: 'accepted', usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1, cost: 0 },
      }),
    })]);
    expect(handlers.logs[0]?.fields).not.toHaveProperty('cacheShare');
  });

  it.each([
    ['length', 'Partial checkpoint', 'rejected', 'response-length'],
    ['error', '', 'failed', 'response-error'],
    ['stop', '', 'rejected', 'response-empty'],
    ['stop', 'All tests passed.', 'rejected', 'unsupported-claim'],
  ])('logs one fresh %s response with outcome %s', async (stopReason, text, outcome, reason) => {
    const handlers = install(vi.fn().mockResolvedValue(assistantResponse(text, stopReason)));
    await expect(handlers.before(compactionEvent())).resolves.toBeUndefined();
    expect(handlers.logs).toEqual([expect.objectContaining({
      level: 'info', msg: 'session compaction request', fields: expect.objectContaining({ outcome, reason }),
    })]);
  });

  it('keeps request logs best effort when the logger fails', async () => {
    const handlers = install(vi.fn().mockResolvedValue(assistantResponse(canonicalSummary())));
    vi.spyOn(handlers.pi.runtime.logger, 'child').mockImplementation(() => { throw new Error('logger failed'); });
    await expect(handlers.before(compactionEvent())).resolves.toHaveProperty('compaction');
  });

  it.each(['summary', 'classifier'] as const)('marks accepted expiry-triggered %s compaction', async (method) => {
    vi.useFakeTimers();
    const complete = vi.fn().mockResolvedValue(assistantResponse(canonicalSummary()));
    const handlers = install(complete, { method }, [], [], { classify: vi.fn() });
    const entries = expiryBranch();
    handlers.setBranch(entries);
    await handlers.emit('agent_settled');
    await vi.advanceTimersByTimeAsync(280_000);
    expect(handlers.ctx.compact).toHaveBeenCalledOnce();

    const result = await handlers.before(compactionEvent(entries));

    expect(result.compaction.details).toMatchObject({ method, trigger: 'cache-expiry' });
    if (method === 'summary') {
      expect(complete).toHaveBeenCalledOnce();
      expect(complete.mock.calls[0]?.[1].messages[0]?.content[0]?.text).toContain('<historical-evidence>');
      expect(complete.mock.calls[0]?.[2]).toMatchObject({ cacheRetention: 'none' });
      expect(handlers.logs.at(-1)?.fields).toMatchObject({ trigger: 'cache-expiry', outcome: 'accepted' });
    } else expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    ['incomplete', () => Promise.resolve(assistantResponse('partial', 'length')), 'rejected', 'model-response-invalid'],
    ['error', () => Promise.resolve(assistantResponse('', 'error')), 'failed', 'model-response-invalid'],
    ['aborted', () => Promise.resolve(assistantResponse('', 'aborted')), 'failed', 'model-response-invalid'],
    ['empty', () => Promise.resolve(assistantResponse('')), 'rejected', 'model-response-invalid'],
    ['unsupported', () => Promise.resolve(assistantResponse('All tests passed.')), 'rejected', 'model-response-unsupported'],
    ['tool call', () => Promise.resolve({ ...assistantResponse(''), content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: {} }] }), 'rejected', 'model-response-invalid'],
    ['request error', () => Promise.reject(new Error('provider unavailable')), 'failed', 'model-request-failed'],
    ['timeout', () => Promise.reject(new Error('Request timed out')), 'failed', 'model-request-failed'],
  ] as const)('cancels an expiry summary after %s without a native fallback diagnostic or warning', async (_name, response, outcome, reason) => {
    vi.useFakeTimers();
    const complete = vi.fn(response);
    const handlers = install(complete, { method: 'summary' });
    const entries = expiryBranch();
    handlers.setBranch(entries);
    await handlers.emit('agent_settled');
    await vi.advanceTimersByTimeAsync(280_000);
    expect(handlers.ctx.compact).toHaveBeenCalledOnce();

    await expect(handlers.before(compactionEvent(entries))).resolves.toEqual({ cancel: true });

    expect(complete).toHaveBeenCalledOnce();
    expect(handlers.diagnostics).toHaveLength(0);
    expect(handlers.notifications).toEqual([{ type: 'info', message: expect.stringContaining('compacting the idle session') }]);
    expect(handlers.logs.slice(-2)).toEqual([
      expect.objectContaining({ msg: 'session compaction request', fields: expect.objectContaining({ trigger: 'cache-expiry', outcome }) }),
      expect.objectContaining({ level: 'info', msg: 'session compaction cache expiry cancelled', fields: expect.objectContaining({ trigger: 'cache-expiry', reason }) }),
    ]);
  });

  it('consumes the expiry trigger when the expiry run is already aborted', async () => {
    vi.useFakeTimers();
    const complete = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    const handlers = install(complete, { method: 'summary' });
    const entries = expiryBranch();
    handlers.setBranch(entries);
    await handlers.emit('agent_settled');
    await vi.advanceTimersByTimeAsync(280_000);
    expect(handlers.ctx.compact).toHaveBeenCalledOnce();
    const aborted = new AbortController();
    aborted.abort();

    await expect(handlers.before({ ...compactionEvent(entries), signal: aborted.signal })).resolves.toEqual({ cancel: true });
    await expect(handlers.before(compactionEvent(entries))).resolves.toBeUndefined();

    expect(handlers.diagnostics).toHaveLength(1);
  });

  it.each([true, false])('tries a verified summary after an expiry classifier failure (summary succeeds: %s)', async (succeeds) => {
    vi.useFakeTimers();
    const complete = succeeds
      ? vi.fn().mockResolvedValue(assistantResponse(canonicalSummary()))
      : vi.fn().mockRejectedValue(new Error('summary unavailable'));
    const classify = vi.fn().mockRejectedValue(new Error('classifier unavailable'));
    const handlers = install(complete, { method: 'classifier' }, [], [], { classify });
    const entries = expiryBranch();
    handlers.setBranch(entries);
    await handlers.emit('agent_settled');
    await vi.advanceTimersByTimeAsync(280_000);
    expect(handlers.ctx.compact).toHaveBeenCalledOnce();

    const result = await handlers.before({ ...compactionEvent(entries), preparation: classifierPreparation() });

    if (succeeds) expect(result.compaction.details).toMatchObject({ method: 'summary', trigger: 'cache-expiry' });
    else expect(result).toEqual({ cancel: true });
    expect(classify).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[2]).toMatchObject({ cacheRetention: 'none' });
    expect(handlers.diagnostics).toHaveLength(0);
    expect(handlers.notifications).toHaveLength(1);
    expect(handlers.notifications[0]).toMatchObject({ type: 'info' });
  });

  it.each(['summary', 'classifier'] as const)('cancels an expiry %s preparation failure instead of falling back to native', async (method) => {
    vi.useFakeTimers();
    const complete = vi.fn();
    const handlers = install(complete, { method }, [], [], { classify: vi.fn() });
    const entries = expiryBranch();
    handlers.setBranch(entries);
    await handlers.emit('agent_settled');
    await vi.advanceTimersByTimeAsync(280_000);

    await expect(handlers.before({ ...compactionEvent(entries), preparation: {
      ...prepared(), turnPrefixMessages: [{ role: 'user', content: 'x'.repeat(65 * 1_024) }],
    } })).resolves.toEqual({ cancel: true });

    expect(complete).not.toHaveBeenCalled();
    expect(handlers.diagnostics).toHaveLength(0);
    expect(handlers.notifications).toHaveLength(1);
    expect(handlers.logs.at(-1)).toMatchObject({
      msg: 'session compaction cache expiry cancelled', fields: { trigger: 'cache-expiry' },
    });
  });

  it('cancels an expiry summary if the prompt exceeds model capacity', async () => {
    vi.useFakeTimers();
    const complete = vi.fn();
    const handlers = install(complete);
    const entries = expiryBranch();
    handlers.setBranch(entries);
    handlers.ctx.model.contextWindow = 1;
    await handlers.emit('agent_settled');
    await vi.advanceTimersByTimeAsync(280_000);

    await expect(handlers.before(compactionEvent(entries))).resolves.toEqual({ cancel: true });

    expect(complete).not.toHaveBeenCalled();
    expect(handlers.diagnostics).toHaveLength(0);
    expect(handlers.notifications).toHaveLength(1);
  });

  it.each([
    ['evidence extraction', () => vi.spyOn(extraction, 'extractEvidence')],
    ['split-prefix rendering', () => vi.spyOn(splitPrefix, 'renderSplitTurnPrefix')],
    ['compaction details', () => vi.spyOn(continuity, 'createCompactionDetails')],
  ] as const)('cancels expiry compaction when %s throws', async (_name, spy) => {
    vi.useFakeTimers();
    const complete = vi.fn().mockResolvedValue(assistantResponse(canonicalSummary()));
    const handlers = install(complete);
    const entries = expiryBranch();
    handlers.setBranch(entries);
    await handlers.emit('agent_settled');
    await vi.advanceTimersByTimeAsync(280_000);
    spy().mockImplementationOnce(() => { throw new Error('preparation failed'); });

    await expect(handlers.before(compactionEvent(entries))).resolves.toEqual({ cancel: true });

    expect(handlers.diagnostics).toHaveLength(0);
    expect(handlers.notifications).toHaveLength(1);
  });

  it('cancels an expiry summary if its model becomes unavailable', async () => {
    vi.useFakeTimers();
    const complete = vi.fn();
    const handlers = install(complete);
    const entries = expiryBranch();
    handlers.setBranch(entries);
    await handlers.emit('agent_settled');
    await vi.advanceTimersByTimeAsync(280_000);
    expect(handlers.ctx.compact).toHaveBeenCalledOnce();
    handlers.ctx.model = undefined;

    await expect(handlers.before(compactionEvent(entries))).resolves.toEqual({ cancel: true });

    expect(complete).not.toHaveBeenCalled();
    expect(handlers.diagnostics).toHaveLength(0);
    expect(handlers.notifications).toHaveLength(1);
  });

  it.each([
    [{ compactBeforeCacheExpiry: false }, 'disabled'],
    [{ compactBeforeCacheExpiry: 'false' }, 'compact'],
    [{ minContextTokens: -1 }, 'context-too-small'],
    [{ minContextTokens: 1.5 }, 'context-too-small'],
    [{ minContextTokens: Infinity }, 'context-too-small'],
    [{ minContextTokens: NaN }, 'context-too-small'],
    [{ minContextTokens: '0' }, 'context-too-small'],
    [{ minContextTokens: 0 }, 'compact'],
    [{ minContextTokens: 199_999 }, 'compact'],
    [{}, 'compact'],
    [{ model: 'low' }, 'compact'],
  ] as const)('validates expiry configuration %j (%s)', async (config, expectedReason) => {
    vi.useFakeTimers();
    const handlers = install(vi.fn(), { method: 'summary', ...config }, [
      { provider: 'anthropic', id: 'claude-haiku-4-5', input: ['text'], maxTokens: 1_000 },
    ]);
    handlers.setBranch(expiryBranch());
    if ('minContextTokens' in config && config.minContextTokens !== 0) {
      handlers.ctx.getContextUsage.mockReturnValue({ tokens: 199_999 });
    }
    await handlers.emit('agent_settled');
    await vi.advanceTimersByTimeAsync(280_000);
    expect(handlers.ctx.compact).toHaveBeenCalledTimes(expectedReason === 'compact' ? 1 : 0);
    if (expectedReason === 'disabled') expect(handlers.logs).toHaveLength(0);
    else expect(handlers.logs.at(-1)?.fields.reason).toBe(expectedReason);
  });

  it.each([
    ['summary', false, false, 'model-unavailable'],
    ['summary', true, false, 'model-unavailable'],
    ['summary', false, true, 'compact'],
    ['classifier', false, false, 'model-unavailable'],
    ['classifier', false, true, 'compact'],
    ['classifier', true, false, 'compact'],
  ] as const)('checks expiry eligibility for %s (classifier: %s, model: %s)', async (method, hasClassifier, hasModel, expectedReason) => {
    vi.useFakeTimers();
    const handlers = install(vi.fn(), { method }, [], [], hasClassifier ? { classify: vi.fn() } : undefined);
    handlers.setBranch(expiryBranch());
    if (!hasModel) handlers.ctx.model = undefined;
    await handlers.emit('agent_settled');
    await vi.advanceTimersByTimeAsync(280_000);

    expect(handlers.ctx.compact).toHaveBeenCalledTimes(expectedReason === 'compact' ? 1 : 0);
    expect(handlers.logs.at(-1)?.fields.reason).toBe(expectedReason);
  });

  it('keeps classifier usage metadata in the existing debug log', async () => {
    const metadata = { provider: 'test', model: 'classifier', usage: { inputTokens: 100, outputTokens: 10, cost: 0.01 } };
    const classify = vi.fn(async () => ({ answers: {}, metadata }));
    const handlers = install(vi.fn(), { method: 'classifier' }, [], [], { classify });
    await handlers.before({ ...compactionEvent(), preparation: classifierPreparation() });
    expect(handlers.logs).toEqual([expect.objectContaining({
      level: 'debug', msg: 'session compaction prune',
      fields: expect.objectContaining({ report: expect.objectContaining({ classifier: metadata }) }),
    })]);
  });
});

function install(
  complete: (...args: any[]) => any,
  config: Record<string, unknown> = {},
  available: readonly Record<string, unknown>[] = [],
  scopedModels: readonly Record<string, unknown>[] = [],
  classifier?: { classify: (...args: any[]) => Promise<unknown> },
) {
  const registered = new Map<string, ((...args: any[]) => any)[]>();
  const diagnostics: unknown[] = [];
  const notifications: unknown[] = [];
  const logs: LogRecord[] = [];
  let entries: any[] = branch();
  const model = { provider: 'test', id: 'model', maxTokens: 4_096, input: ['text'], promptCache: { short: 300 } };
  const pi = {
    config,
    runtime: {
      logger: createLogger({
        level: 'debug',
        destination: { write: (record) => { logs.push(record); } },
      }),
      ...(classifier === undefined ? {} : { classifier }),
    },
    on: (name: string, handler: (...args: any[]) => any) => registered.set(name, [...(registered.get(name) ?? []), handler]),
    appendEntry: (_type: string, data: unknown) => { diagnostics.push(data); },
    getSettings: () => ({}),
  } as unknown as FelanExtensionAPI;
  createSessionCompactionExtension()(pi);
  const ctx = {
    model,
    thinkingLevel: 'off',
    scopedModels,
    modelRegistry: {
      complete,
      getAvailable: () => available,
    },
    sessionManager: {
      getSessionId: () => 'session-1',
      getBranch: () => entries,
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: vi.fn(() => ({ tokens: 200_000 })),
    compact: vi.fn(),
    ui: { notify: (message: string, type: string) => { notifications.push({ message, type }); } },
  } as any;
  const emit = async (name: string, event: any = {}, context = ctx) => {
    let result: any;
    for (const handler of registered.get(name) ?? []) {
      const response = await handler(event, context);
      if (response !== undefined) result = response;
    }
    return result;
  };
  return {
    before: (event: any) => {
      entries = event.branchEntries;
      return emit('session_before_compact', event);
    },
    emit,
    setBranch: (branchEntries: any[]) => { entries = branchEntries; },
    ctx,
    pi,
    diagnostics,
    notifications,
    logs,
  };
}

function expiryBranch() {
  const messages = [
    { role: 'user', content: 'Fix login. Always run tests.', timestamp: Date.now() - 3_000 },
    { role: 'user', content: 'Continue fixing login.', timestamp: Date.now() - 2_000 },
    { ...assistantResponse('Working on login.'), usage: { ...assistantResponse('').usage, cacheWrite: 100, cacheWrite1h: 0 } },
  ];
  return messages.map((message, index) => ({
    type: 'message', id: ['earlier', 'keep-1', 'reply'][index], parentId: null,
    timestamp: new Date(message.timestamp).toISOString(), message,
  }));
}

function compactionEvent(entries: any[] = branch()) {
  return { preparation: prepared(), branchEntries: entries, reason: 'manual', willRetry: false, signal: new AbortController().signal };
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

function classifierPreparation() {
  return {
    ...prepared(),
    messagesToSummarize: [
      { role: 'user', content: 'Fix login.' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'unknown_tool', arguments: {} }] },
      {
        role: 'toolResult', toolCallId: 'call-1', toolName: 'unknown_tool', isError: false,
        content: [{ type: 'text', text: `CLASSIFIER_FAILURE_OUTPUT ${'x'.repeat(120)}` }],
      },
    ],
  };
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
