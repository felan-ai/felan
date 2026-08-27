import {
  AssistantMessageComponent,
  getMarkdownTheme,
  initTheme,
} from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createThinkingGroupExtension,
  renderThinkingGroupMarkdown,
} from '../src/thinking-groups.js';

beforeAll(() => initTheme('dark', false));

describe('thinking groups', () => {
  it('groups thinking sentences without changing other Markdown', () => {
    const context = {
      messageType: 'assistant-thinking' as const,
      isStreaming: false,
      availableWidth: 80,
    };

    expect(renderThinkingGroupMarkdown('Inspect code. Update tests.\nRun checks.', context)).toBe([
      '**Thinking**  ',
      '  · Inspect code.  ',
      '  · Update tests.  ',
      '  · Run checks.  ',
    ].join('\n'));
    expect(renderThinkingGroupMarkdown('Regular answer', {
      ...context,
      messageType: 'assistant',
    })).toBe('Regular answer');
    expect(renderThinkingGroupMarkdown('```ts\nconst answer = 42;\n```', context)).toContain(
      '· \\`\\`\\`ts',
    );
  });

  it('renders consecutive thinking blocks as one colored Markdown group', () => {
    const component = new AssistantMessageComponent(
      assistantThinkingMessage([
        'Inspect the current renderer. Add the smallest change.',
        'Run focused tests.',
      ]),
      false,
      getMarkdownTheme(),
      'Thinking...',
      1,
      [renderThinkingGroupMarkdown],
    );

    const lines = component.render(80)
      .map(stripTerminalSequences)
      .map((line) => line.trimEnd());

    expect(lines).toContain(' Thinking');
    expect(lines).toContain('   · Inspect the current renderer.');
    expect(lines).toContain('   · Add the smallest change.');
    expect(lines).toContain('   · Run focused tests.');
    expect(lines).not.toContain(' Thinking...');
  });

  it('preserves the existing hidden-thinking behavior', () => {
    const component = new AssistantMessageComponent(
      assistantThinkingMessage(['Hidden detail.']),
      true,
      getMarkdownTheme(),
      'Thinking...',
      1,
      [renderThinkingGroupMarkdown],
    );
    const output = component.render(80).map(stripTerminalSequences).join('\n');

    expect(output).toContain('Thinking...');
    expect(output).not.toContain('Hidden detail');
  });

  it('registers the transformer through a hidden local extension', async () => {
    const registerMarkdownTransformer = vi.fn();
    const extension = createThinkingGroupExtension();

    await extension.factory({ registerMarkdownTransformer } as never);

    expect(extension.hidden).toBe(true);
    expect(registerMarkdownTransformer).toHaveBeenCalledWith(renderThinkingGroupMarkdown);
  });
});

function assistantThinkingMessage(thinking: readonly string[]) {
  return {
    role: 'assistant' as const,
    content: thinking.map((text) => ({ type: 'thinking' as const, thinking: text })),
    api: 'anthropic-messages' as const,
    provider: 'anthropic',
    model: 'test-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop' as const,
    timestamp: 1,
  };
}
