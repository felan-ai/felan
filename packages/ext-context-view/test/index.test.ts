import {
  getExtensionConfigDefinition,
  type ExtensionCommandContext,
  type ExtensionContext,
  type FelanExtensionAPI,
  type SessionEntry,
} from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import contextViewExtension, {
  CONTEXT_VIEW_CONFIG,
  collectContextReport,
  ContextUsageOverlay,
  type ContextReport,
} from '../src/index.js';

function theme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as ExtensionContext['ui']['theme'];
}

function context(overrides: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
  return {
    mode: 'print',
    hasUI: false,
    cwd: '/workspace',
    model: { id: 'model', name: 'Model', contextWindow: 100_000 },
    ui: { notify: vi.fn() },
    sessionManager: {
      getBranch: () => [],
    },
    getContextUsage: () => ({ tokens: 12, contextWindow: 100_000, percent: 0.012 }),
    getSystemPrompt: () => '<project_context>\n<project_instructions path="/workspace/AGENTS.md">rules</project_instructions>\n</project_context>\n<available_skills><skill /></available_skills>',
    getSystemPromptOptions: () => ({ cwd: '/workspace', contextFiles: [{ path: '/workspace/AGENTS.md', content: 'rules' }], skills: [] }),
    ...overrides,
  } as ExtensionCommandContext;
}

function pi(overrides: Partial<FelanExtensionAPI> = {}): FelanExtensionAPI {
  return {
    config: {},
    on: vi.fn(),
    registerCommand: vi.fn(),
    getActiveTools: () => ['read', 'custom_tool'],
    getAllTools: () => [
      { name: 'read', description: 'read files', parameters: {}, sourceInfo: { path: '<inline:@felan-ai/agent-core/runtime-tools>', source: 'inline', scope: 'temporary', origin: 'top-level' } },
      { name: 'custom_tool', description: 'custom', parameters: {}, sourceInfo: { path: '<inline:@felan-ai/ext-example>', source: 'inline', scope: 'temporary', origin: 'top-level' } },
    ],
    getCommands: () => [],
    ...overrides,
  } as unknown as FelanExtensionAPI;
}

describe('@felan-ai/ext-context-view', () => {
  it('declares inline as its configurable display default', () => {
    expect(getExtensionConfigDefinition(contextViewExtension)).toBe(CONTEXT_VIEW_CONFIG);
    expect(CONTEXT_VIEW_CONFIG.fields.displayMode).toMatchObject({
      default: 'inline',
      values: ['inline', 'overlay'],
    });
  });

  it('registers /context and reports Felan prompt sections and tools', async () => {
    const api = pi();
    contextViewExtension(api);
    const handler = (api.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0]![1].handler as (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    const ctx = context();
    await handler('', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Context Usage: 78 / 100k'), 'info');
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Context Files: 29'), 'info');
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('example: 1 tool'), 'info');
  });

  it('renders inline by default and preserves the configured TUI overlay', async () => {
    const observedOptions: Array<Parameters<ExtensionContext['ui']['custom']>[1]> = [];

    for (const config of [{}, { displayMode: 'overlay' }] as const) {
      const api = pi({ config });
      contextViewExtension(api);
      const handler = (api.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0]![1].handler as (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      const done = vi.fn();
      const custom = vi.fn(async (
        factory: Parameters<ExtensionContext['ui']['custom']>[0],
        options?: Parameters<ExtensionContext['ui']['custom']>[1],
      ) => {
        observedOptions.push(options);
        const component = await factory({ requestRender: vi.fn() } as never, theme(), {} as never, done);
        component.handleInput?.('q');
        expect(component.render(80).length).toBeGreaterThan(0);
      });
      const ctx = context({ mode: 'tui', hasUI: true, ui: { ...context().ui, custom } as unknown as ExtensionContext['ui'] });
      await handler('', ctx);
      expect(custom).toHaveBeenCalledOnce();
      expect(done).toHaveBeenCalledOnce();
    }

    expect(observedOptions[0]).toBeUndefined();
    expect(observedOptions[1]).toMatchObject({
      overlay: true,
      overlayOptions: { width: 88, minWidth: 56, maxHeight: '90%', margin: 2 },
    });
  });

  it('keeps report rendering bounded and handles unknown context windows', () => {
    const report: ContextReport = {
      breakdown: { systemPrompt: 1, systemTools: 2, extensions: 3, contextFiles: 4, skills: 5, memory: 6, messages: 7, other: 8, available: 0 },
      usedTokens: 28,
      contextWindow: null,
      usagePercent: null,
      estimated: true,
      systemToolCount: 1,
      extensionToolCount: 1,
      contextFileCount: 0,
      skillCount: 0,
      memory: { summary: 1, index: 2, schema: 3, recalls: 0 },
      extensionDetails: [],
      skillDetails: [],
      modelLabel: null,
    };
    const overlay = new ContextUsageOverlay(report, theme(), vi.fn());
    expect(overlay.render(20).every((line) => line.length <= 20)).toBe(true);
    overlay.handleInput('enter');
  });

  it('uses two horizontal separators inline and a four-edge frame in overlay mode', () => {
    const report: ContextReport = {
      breakdown: { systemPrompt: 1, systemTools: 2, extensions: 3, contextFiles: 4, skills: 5, memory: 6, messages: 7, other: 8, available: 0 },
      usedTokens: 36,
      contextWindow: null,
      usagePercent: null,
      estimated: true,
      systemToolCount: 0,
      extensionToolCount: 0,
      contextFileCount: 0,
      skillCount: 0,
      memory: { summary: 1, index: 1, schema: 1, recalls: 1 },
      extensionDetails: [],
      skillDetails: [],
      modelLabel: null,
    };
    const inline = new ContextUsageOverlay(report, theme(), vi.fn(), 'inline').render(40);
    expect(inline[0]).toBe('─'.repeat(40));
    expect(inline.at(-1)).toBe('─'.repeat(40));
    expect(inline.some((line) => line.startsWith('│'))).toBe(false);

    const overlay = new ContextUsageOverlay(report, theme(), vi.fn(), 'overlay').render(40);
    expect(overlay[0]).toBe(`╭${'─'.repeat(38)}╮`);
    expect(overlay.at(-1)).toBe(`╰${'─'.repeat(38)}╯`);
    expect(overlay.slice(1, -1).every((line) => line.startsWith('│') && line.endsWith('│'))).toBe(true);
  });

  it('uses the current Felan context-file XML and compaction-aware branch entries', () => {
    const entry = {
      type: 'message', id: 'm1', parentId: null, timestamp: '1',
      message: { role: 'user', content: 'message content', timestamp: 1 },
    } as unknown as SessionEntry;
    const report = collectContextReport(pi(), context({ sessionManager: { getBranch: () => [entry] } as never }), undefined, undefined);
    expect(report.contextFileCount).toBe(1);
    expect(report.breakdown.messages).toBeGreaterThan(0);
  });

  it('attributes injected memory and recalled memory files separately from messages', () => {
    const entries = [
      {
        type: 'custom_message', id: 'memory', parentId: null, timestamp: '1',
        customType: 'felan-memory-context', display: false,
        content: 'Summary:\nsummary text\n\nIndex:\nindex text\n\nSchema:\nschema text',
      },
      {
        type: 'message', id: 'assistant', parentId: 'memory', timestamp: '2',
        message: {
          role: 'assistant', content: [
            { type: 'toolCall', id: 'recall', name: 'read', arguments: { path: '.memory/pages/project.md' } },
            { type: 'text', text: 'ordinary answer' },
          ],
        },
      },
      {
        type: 'message', id: 'recall-result', parentId: 'assistant', timestamp: '3',
        message: {
          role: 'toolResult', toolCallId: 'recall', toolName: 'read',
          content: [{ type: 'text', text: 'recalled page' }],
        },
      },
      {
        type: 'message', id: 'user', parentId: 'recall-result', timestamp: '4',
        message: { role: 'user', content: 'ordinary user message' },
      },
    ] as unknown as SessionEntry[];
    const report = collectContextReport(pi(), context({ sessionManager: { getBranch: () => entries } as never }), undefined, undefined);

    expect(report.memory.summary).toBeGreaterThan(0);
    expect(report.memory.index).toBeGreaterThan(0);
    expect(report.memory.schema).toBeGreaterThan(0);
    expect(report.memory.recalls).toBeGreaterThan(0);
    expect(report.breakdown.memory).toBe(
      report.memory.summary + report.memory.index + report.memory.schema + report.memory.recalls,
    );
    expect(report.breakdown.messages).toBeGreaterThan(0);
  });
});
