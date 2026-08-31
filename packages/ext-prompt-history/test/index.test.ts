import type { ExtensionCommandContext, ExtensionContext, FelanExtensionAPI, SessionEntry } from '@felan-ai/agent-core';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import { createPromptHistoryExtension, PROMPT_HISTORY_CONFIG } from '../src/index.js';
import { collectPrompts, limitedPrompts } from '../src/history.js';
import { PromptHistoryPicker } from '../src/picker.js';

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as ExtensionContext['ui']['theme'];

describe('@felan-ai/ext-prompt-history', () => {
  it('declares inline as the default and registers both platform shortcuts', () => {
    expect(PROMPT_HISTORY_CONFIG.fields.displayMode).toMatchObject({ default: 'inline', values: ['inline', 'overlay'] });
    const api = fakePi();
    createPromptHistoryExtension({ listSessions: async () => [], readSession: async () => undefined })(api);
    expect(api.registerShortcut).toHaveBeenCalledTimes(2);
  });

  it('collects text prompts, ignores empty content, and keeps newest duplicates', () => {
    const items = collectPrompts([
      entry('old', 'same', '2026-01-01T00:00:00Z'),
      entry('new', 'same', '2026-01-02T00:00:00Z'),
      entry('empty', '  ', '2026-01-03T00:00:00Z'),
      entry('parts', [{ type: 'text', text: 'hello ' }, { type: 'image', data: 'ignored' }, { type: 'text', text: 'world' }], '2026-01-04T00:00:00Z'),
    ], { identity: 'session', cwd: '/workspace', sessionLabel: 'session.jsonl', timestampFallback: 0 });
    expect(limitedPrompts(items, '')).toMatchObject([{ text: 'hello world' }, { text: 'same' }]);
  });

  it('supports inline by default, overlay configuration, TUI-only behavior, and editor replacement', async () => {
    const host = { listSessions: async () => [], readSession: async () => undefined };
    const options: unknown[] = [];
    const setEditorText = vi.fn();
    const api = fakePi({ config: {}, registerShortcut: vi.fn() });
    const configured = createPromptHistoryExtension(host);
    configured(api);
    const handler = (api.registerShortcut as ReturnType<typeof vi.fn>).mock.calls[0]![1].handler as (ctx: ExtensionContext) => Promise<void>;
    const custom = vi.fn(async (factory: Parameters<ExtensionContext['ui']['custom']>[0], opts?: Parameters<ExtensionContext['ui']['custom']>[1]) => {
      options.push(opts);
      const done = vi.fn();
      const component = await factory({ requestRender: vi.fn() } as never, theme, {} as never, done);
      return { text: 'selected' };
    });
    const ctx = fakeContext({ mode: 'tui', hasUI: true, setEditorText, ui: { custom, setEditorText } });
    await handler(ctx);
    expect(custom).toHaveBeenCalledOnce();
    expect(setEditorText).toHaveBeenCalledWith('selected');
    expect(options[0]).toBeUndefined();
    const overlayApi = fakePi({ config: { displayMode: 'overlay' }, registerShortcut: vi.fn() });
    createPromptHistoryExtension(host)(overlayApi);
    const overlayHandler = (overlayApi.registerShortcut as ReturnType<typeof vi.fn>).mock.calls[0]![1].handler as (ctx: ExtensionContext) => Promise<void>;
    await overlayHandler(fakeContext({ mode: 'tui', hasUI: true, ui: { custom, setEditorText } }));
    expect(options[1]).toMatchObject({ overlay: true, overlayOptions: { width: '80%', minWidth: 64, maxHeight: '90%', margin: 2 } });
    await handler(fakeContext({ mode: 'print', hasUI: false }));
    expect(custom).toHaveBeenCalledTimes(2);
  });

  it('renders and navigates the picker without exceeding the requested width', () => {
    const source = { cwd: '/workspace', sessionDirectory: '/sessions', host: { listSessions: async () => [], readSession: async () => undefined }, getCurrentItems: () => [
      { id: '1', text: 'find the important thing', cwd: '/workspace', sessionLabel: 'current', timestamp: 1 },
    ] };
    const done = vi.fn();
    const picker = new PromptHistoryPicker(source, theme as never, vi.fn(), done);
    picker.handleInput('x');
    expect(picker.render(80).every((line) => line.length <= 80)).toBe(true);
    picker.handleInput('\x1b');
    expect(done).toHaveBeenCalledWith(undefined);
  });

  it('uses two horizontal separators inline and a four-edge frame in overlay mode', () => {
    const source = {
      cwd: '/workspace',
      sessionDirectory: '/sessions',
      host: { listSessions: async () => [], readSession: async () => undefined },
      getCurrentItems: () => [],
    };
    const makePicker = (displayMode: 'inline' | 'overlay') => new PromptHistoryPicker(
      source,
      theme,
      vi.fn(),
      vi.fn(),
      displayMode,
    );

    const inline = makePicker('inline').render(40);
    expect(inline[0]).toBe('─'.repeat(40));
    expect(inline.at(-1)).toBe('─'.repeat(40));
    expect(inline.some((line) => line.startsWith('│'))).toBe(false);

    const overlay = makePicker('overlay').render(40);
    expect(overlay[0]).toBe(`╭${'─'.repeat(38)}╮`);
    expect(overlay.at(-1)).toBe(`╰${'─'.repeat(38)}╯`);
    expect(overlay.slice(1, -1).every((line) => line.startsWith('│') && line.endsWith('│'))).toBe(true);
    expect(overlay.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });
});

function entry(id: string, content: unknown, timestamp: string): SessionEntry {
  return { type: 'message', id, parentId: null, timestamp, message: { role: 'user', content } } as unknown as SessionEntry;
}

function fakePi(overrides: Partial<FelanExtensionAPI> = {}): FelanExtensionAPI {
  return { config: {}, registerShortcut: vi.fn(), ...overrides } as unknown as FelanExtensionAPI;
}

function fakeContext(overrides: Record<string, unknown> = {}): ExtensionCommandContext {
  return {
    mode: 'tui', hasUI: true, cwd: '/workspace', ui: { custom: vi.fn(), setEditorText: vi.fn() },
    sessionManager: { getSessionDir: () => '/sessions', getSessionFile: () => '/current.jsonl', getSessionId: () => 'current', getCwd: () => '/workspace', getSessionName: () => undefined, getEntries: () => [] },
    ...overrides,
  } as unknown as ExtensionCommandContext;
}
