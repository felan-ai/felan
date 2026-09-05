import {
  initTheme,
  type AgentSession,
  type KeybindingsManager,
  type Theme,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  SUBAGENT_COMPLETION_MESSAGE_TYPE,
  type SubagentCompletionNotice,
} from '@felan-ai/ext-subagents';
import {
  KeybindingsManager as TuiKeybindingsManager,
  TuiAltScreen,
  TUI_KEYBINDINGS,
  setKeybindings,
  visibleWidth,
  type Component,
  type Terminal,
} from '@earendil-works/pi-tui';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentTranscript } from '../src/subagents/agent-transcript.js';
import {
  AgentNavigator,
  AgentRailEditor,
  AGENT_NAVIGATOR_OVERLAY_OPTIONS,
  registerLocalSubagentNavigator,
  type AgentRailRenderer,
  type LocalSubagentNavigatorHost,
} from '../src/subagents/agent-navigator.js';
import type { LocalSubagentView } from '../src/subagents/host.js';

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

beforeAll(() => {
  initTheme('dark', false);
  setKeybindings(new TuiKeybindingsManager(TUI_KEYBINDINGS));
});

describe('AgentNavigator', () => {
  it('fills the terminal with a width-safe transcript and bounded agent rail', () => {
    const records = Array.from({ length: 7 }, (_, index) => record(
      `agent-${index + 1}`,
      index === 0 ? 'running' : 'completed',
    ));
    const harness = createHarness(records, 12, 48);

    const lines = harness.navigator.render(48);
    const output = lines.join('\n');

    expect(lines).toHaveLength(12);
    expect(lines.every((line) => visibleWidth(line) === 48)).toBe(true);
    expect(lines[0]).toMatch(/^╭.*╮$/u);
    expect(lines.at(-1)).toMatch(/^╰.*╯$/u);
    expect(lines.slice(1, -1).every((line) => line.startsWith('│') && line.endsWith('│'))).toBe(true);
    expect(output).toContain('Viewing reviewer');
    expect(output).toMatch(/[↑↓]\d/);
    harness.navigator.dispose();
  });

  it('switches between subagents and sends steering input to the selection', async () => {
    const first = record('agent-1', 'running', { type: 'reviewer' });
    const second = record('agent-2', 'running', { type: 'developer' });
    const harness = createHarness([first, second]);

    harness.navigator.handleInput('\x1b[B');
    expect(harness.navigator.render(80).join('\n')).toContain('Viewing developer');
    harness.navigator.handleInput('\r');
    for (const character of 'focus here') harness.navigator.handleInput(character);
    harness.navigator.handleInput('\r');

    await vi.waitFor(() => {
      expect(harness.host.steer).toHaveBeenCalledWith(second.agentId, 'focus here');
    });
    harness.navigator.dispose();
  });

  it('shows the resolved model in selected metadata and list rows', () => {
    const withModel = record('agent-1', 'running', {
      type: 'explore',
      model: 'provider/child-model',
    });
    const withoutModel = record('agent-2', 'queued', { type: 'reviewer' });
    const harness = createHarness([withModel, withoutModel], 10, 80);

    const lines = harness.navigator.render(80);
    const output = lines.join('\n');

    expect(output).toContain('Viewing explore · provider/child-model');
    expect(output).toContain('explore · provider/child-model');
    expect(output).not.toContain('reviewer · undefined');
    expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true);
    harness.navigator.dispose();
  });

  it('shows each subagent cost beside its elapsed time', () => {
    const withCost = record('agent-1', 'completed', {
      type: 'explore',
      completedAt: '2026-01-01T00:00:03.000Z',
      usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 0, cost: 0.05134808 },
    });
    const zeroCost = record('agent-2', 'completed', {
      completedAt: '2026-01-01T00:00:04.000Z',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    });
    const unknownCost = record('agent-3', 'completed', {
      completedAt: '2026-01-01T00:00:05.000Z',
    });
    const harness = createHarness([withCost, zeroCost, unknownCost], 10, 80);

    const lines = harness.navigator.render(80);
    const output = lines.join('\n');

    expect(output.match(/\$0\.051/g)).toHaveLength(2);
    expect(output).toContain('$0.000 · 3.0s');
    expect(output.match(/\$/g)).toHaveLength(3);
    expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true);
    harness.navigator.dispose();
  });

  it('refreshes the displayed cost when running usage changes', () => {
    const initial = record('agent-1', 'running', {
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
    });
    const harness = createHarness([initial], 10, 80);

    expect(harness.navigator.render(80).join('\n')).toContain('$0.010');
    harness.setRecords([record('agent-1', 'running', {
      usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
    })]);
    const updated = harness.navigator.render(80).join('\n');

    expect(updated).toContain('$0.020');
    expect(updated).not.toContain('$0.010');
    harness.navigator.dispose();
  });

  it('falls back to the live session model when no request model was stored', () => {
    const session = sessionWithMessages([], () => {}, {
      model: { provider: 'default-provider', id: 'default-model' },
    });
    const harness = createHarness([
      record('agent-1', 'running', { type: 'general', session }),
    ], 10, 80);

    const lines = harness.navigator.render(80);
    const output = lines.join('\n');

    expect(output).toContain('Viewing general · default-provider/default-model');
    expect(output).toContain('general · default-provider/default-model');
    expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true);
    harness.navigator.dispose();
  });

  it('renders live child-session events', () => {
    let listener!: (event: unknown) => void;
    const session = sessionWithMessages(
      [{ role: 'user', content: 'initial activity', timestamp: 1 }],
      (next) => {
        listener = next;
      },
    );
    const harness = createHarness([record('agent-1', 'running', { session })]);
    harness.tui.requestRender.mockClear();

    listener({
      type: 'message_start',
      message: { role: 'user', content: 'live activity', timestamp: 2 },
    });

    expect(harness.tui.requestRender).toHaveBeenCalled();
    expect(harness.navigator.render(80).join('\n')).toContain('live activity');
    harness.navigator.dispose();
  });

  it('scrolls the selected transcript with SGR and legacy mouse-wheel input', () => {
    const session = sessionWithMessages(
      Array.from({ length: 30 }, (_, index) => ({
        role: 'user',
        content: `transcript line ${index + 1}`,
        timestamp: index + 1,
      })),
      () => {},
    );
    const harness = createHarness([
      record('agent-1', 'running', { session }),
      record('agent-2', 'completed'),
    ], 12, 80);

    const first = harness.navigator.render(80).join('\n');
    harness.tui.requestRender.mockClear();
    harness.navigator.handleInput('\x1b[<64;20;5M');
    const afterWheelUp = harness.navigator.render(80).join('\n');

    expect(afterWheelUp).not.toEqual(first);
    expect(afterWheelUp).toContain('Viewing reviewer');
    expect(afterWheelUp).toContain('✓ reviewer');
    expect(harness.tui.requestRender).toHaveBeenCalledOnce();

    harness.navigator.handleInput('\x1b[M' + String.fromCharCode(65 + 32, 33, 33));
    expect(harness.navigator.render(80).join('\n')).toEqual(first);
    expect(harness.tui.requestRender).toHaveBeenCalledTimes(2);
    harness.navigator.dispose();
  });

  it('ignores non-wheel mouse input and scrolls while the steering input is focused', () => {
    const session = sessionWithMessages(
      Array.from({ length: 30 }, (_, index) => ({
        role: 'user',
        content: `transcript line ${index + 1}`,
        timestamp: index + 1,
      })),
      () => {},
    );
    const harness = createHarness([record('agent-1', 'running', { session })], 12, 80);

    const first = harness.navigator.render(80).join('\n');
    harness.tui.requestRender.mockClear();
    harness.navigator.handleInput('\x1b[<0;20;5M');
    expect(harness.navigator.render(80).join('\n')).toEqual(first);
    expect(harness.tui.requestRender).not.toHaveBeenCalled();

    harness.navigator.handleInput('\r');
    harness.tui.requestRender.mockClear();
    harness.navigator.handleInput('\x1b[<64;20;5M');
    expect(harness.navigator.render(80).join('\n')).not.toEqual(first);
    expect(harness.tui.requestRender).toHaveBeenCalledOnce();
    harness.navigator.dispose();
  });

  it('receives wheel input through a focused fullscreen TUI overlay', () => {
    const terminal = new TestTerminal();
    const tui = new TuiAltScreen(terminal);
    const session = sessionWithMessages(
      Array.from({ length: 30 }, (_, index) => ({
        role: 'user',
        content: `transcript line ${index + 1}`,
        timestamp: index + 1,
      })),
      () => {},
    );
    const host = navigatorHost(() => [record('agent-1', 'running', { session })]);
    const navigator = new AgentNavigator(
      tui,
      host,
      theme,
      new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager,
      vi.fn(),
    );
    tui.showOverlay(navigator, AGENT_NAVIGATOR_OVERLAY_OPTIONS);
    tui.start();

    try {
      tui.renderNow(true);
      const first = navigator.render(terminal.columns).join('\n');
      terminal.send('\x1b[<64;20;5M');
      const afterWheelUp = navigator.render(terminal.columns).join('\n');

      expect(afterWheelUp).not.toEqual(first);
      expect(afterWheelUp).toContain('Viewing reviewer');
    } finally {
      navigator.dispose();
      tui.stop();
    }
  });

  it('uses the grouped tool presentation for selected child transcripts', () => {
    const definition = toolDefinition('read');
    const session = sessionWithMessages([
      assistantToolCall('read-1', 'read', { path: 'src/a.ts' }),
    ], () => {}, {
      definition,
    });
    const keybindings = new TuiKeybindingsManager(TUI_KEYBINDINGS);
    const transcript = new AgentTranscript(
      { requestRender: vi.fn() } as never,
      keybindings as unknown as KeybindingsManager,
    );

    transcript.attach(session);
    const output = transcript.render(100).join('\n');

    expect(output).toContain('Reading 1 file');
    expect(output).toContain('Reading · src/a.ts');
    transcript.handleInput('\x0f');
    expect(transcript.render(100).join('\n')).not.toContain('Alt+T full details');
    transcript.dispose();
  });

  it('uses grouped thinking rows for selected child transcripts', () => {
    const session = sessionWithMessages([
      assistantThinking('Inspect the child session. Render the next sentence.'),
    ], () => {});
    const transcript = new AgentTranscript(
      { requestRender: vi.fn() } as never,
      new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager,
    );

    transcript.attach(session);
    const output = transcript.render(100).join('\n');

    expect(output).toContain('Thinking');
    expect(output).toContain('· Inspect the child session.');
    expect(output).toContain('· Render the next sentence.');
    transcript.dispose();
  });

  it('keeps grouped child tools live and releases both session subscriptions', () => {
    const definition = toolDefinition('read');
    const listeners: Array<(event: unknown) => void> = [];
    const unsubscribes: Array<ReturnType<typeof vi.fn>> = [];
    const session = sessionWithMessages([], (listener) => listeners.push(listener), {
      definition,
      unsubscribes,
    });
    const transcript = new AgentTranscript(
      { requestRender: vi.fn() } as never,
      new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager,
    );

    transcript.attach(session);
    const message = assistantToolCall('read-1', 'read', { path: 'src/a.ts' });
    for (const listener of listeners) listener({ type: 'message_start', message });
    for (const listener of listeners) listener({
      type: 'tool_execution_start',
      toolCallId: 'read-1',
      toolName: 'read',
      args: { path: 'src/a.ts' },
    });
    for (const listener of listeners) listener({
      type: 'tool_execution_end',
      toolCallId: 'read-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'file contents' }] },
      isError: false,
    });

    expect(transcript.render(100).join('\n')).toContain('Read 1 file');
    expect(listeners).toHaveLength(2);
    transcript.dispose();
    expect(unsubscribes).toHaveLength(2);
    expect(unsubscribes.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(true);
  });

  it('closes without stopping the selected subagent', () => {
    const harness = createHarness([record('agent-1')]);

    harness.navigator.handleInput('\x1b');

    expect(harness.done).toHaveBeenCalledOnce();
    expect(harness.host.cancel).not.toHaveBeenCalled();
    harness.navigator.dispose();
  });
});

describe('AgentRailEditor', () => {
  it('shows only active subagents and moves focus through the rail from prompt history', () => {
    const records = [
      record('agent-1', 'running', { type: 'explore', model: 'provider/explore-model' }),
      record('agent-2', 'queued', { type: 'developer' }),
      record('agent-3', 'completed', { type: 'finished' }),
    ];
    const host = navigatorHost(() => records);
    const tui = {
      terminal: { rows: 20, columns: 80 },
      requestRender: vi.fn(),
    };
    const opened = vi.fn();
    const keybindings = new TuiKeybindingsManager(TUI_KEYBINDINGS);
    const editor = new AgentRailEditor(
      tui as never,
      { borderColor: (text: string) => text, selectList: {} } as never,
      keybindings as unknown as KeybindingsManager,
      host,
      () => theme,
      opened,
    );
    editor.focused = true;
    editor.addToHistory('previous prompt');

    editor.handleInput('\x1b[A');
    expect(editor.getText()).toBe('previous prompt');
    editor.handleInput('\x1b[B');
    expect(editor.getText()).toBe('');
    editor.handleInput('\x1b[B');

    let output = editor.render(80).join('\n');
    expect(output).not.toContain('╭');
    expect(output.split('\n')[0]).toBe('─'.repeat(80));
    expect(output).toContain('› ● explore');
    expect(output).toContain('provider/explore-model');
    expect(output).toContain('◦ developer');
    expect(output).not.toContain('finished');
    expect(output).not.toContain('\x1b[7m');

    editor.handleInput('\x1b[B');
    editor.handleInput('\r');
    expect(opened).toHaveBeenCalledWith('agent-2');

    editor.handleInput('\x1b[A');
    editor.handleInput('\x1b[A');
    output = editor.render(80).join('\n');
    expect(output).not.toContain('›');
    editor.handleInput('\x1b[A');
    expect(editor.getText()).toBe('previous prompt');
  });

  it('uses the full row width for live activity', () => {
    const activity = `Reviewing ${'detailed output '.repeat(4)}VISIBLE-END`;
    const startedAt = new Date().toISOString();
    const host = navigatorHost(() => [record('agent-1', 'running', {
      type: 'explore',
      createdAt: startedAt,
      startedAt,
      session: sessionWithStreamingText(activity),
    })]);
    const editor = new AgentRailEditor(
      { terminal: { rows: 20, columns: 120 }, requestRender: vi.fn() } as never,
      { borderColor: (text: string) => text, selectList: {} } as never,
      new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager,
      host,
      () => theme,
      vi.fn(),
    );

    const [row] = editor.renderRail(120);

    expect(row).toContain('VISIBLE-END');
    expect(visibleWidth(row!)).toBe(120);
  });

  it('preserves Pi scroll indicators and native editor width', () => {
    const host = navigatorHost(() => []);
    const editor = new AgentRailEditor(
      { terminal: { rows: 20, columns: 80 }, requestRender: vi.fn() } as never,
      { borderColor: (text: string) => text, selectList: {} } as never,
      new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager,
      host,
      () => theme,
      vi.fn(),
    );
    editor.focused = true;
    editor.setText(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n'));

    const lines = editor.render(80);

    expect(lines.join('\n')).toMatch(/↑\s*\d+\s+more/u);
    expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true);
    expect(lines.join('\n')).not.toContain('╭');
    expect(lines.join('\n')).not.toContain('│');
  });
});

describe('registerLocalSubagentNavigator', () => {
  it('registers TUI controls and exposes the rail separately from the editor', () => {
    const commands = new Map<string, unknown>();
    const messageRenderers = new Map<string, CompletionRenderer>();
    const shortcuts: unknown[] = [];
    const handlers = new Map<string, Array<(event: unknown, context: unknown) => void>>();
    const pi = {
      on: vi.fn((event: string, handler: (event: unknown, context: unknown) => void) => {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
      }),
      registerCommand: vi.fn((name, command) => commands.set(name, command)),
      registerMessageRenderer: vi.fn((name, renderer) => messageRenderers.set(name, renderer)),
      registerShortcut: vi.fn((shortcut, definition) => shortcuts.push([shortcut, definition])),
    };
    const host = navigatorHost(() => [record('agent-1')]);
    let editor: AgentRailEditor | undefined;
    let railRenderer: AgentRailRenderer | undefined;
    const setEditorComponent = vi.fn((factory) => {
      editor = factory(
        { terminal: { rows: 20, columns: 80 }, requestRender: vi.fn() },
        { borderColor: (text: string) => text, selectList: {} },
        new TuiKeybindingsManager(TUI_KEYBINDINGS),
      );
    });
    registerLocalSubagentNavigator(pi as never, host, {
      renderRailInEditor: () => false,
      onRailRendererChange: (renderer) => {
        railRenderer = renderer;
      },
    });
    const context = { mode: 'tui', ui: { setEditorComponent, theme } };

    handlers.get('session_start')![0]!({}, { mode: 'print' });
    expect(commands.size).toBe(0);
    handlers.get('session_start')![0]!({}, context);

    expect(commands.has('agents')).toBe(true);
    expect(messageRenderers.has(SUBAGENT_COMPLETION_MESSAGE_TYPE)).toBe(true);
    expect(shortcuts).toHaveLength(1);
    expect(setEditorComponent).toHaveBeenCalledOnce();
    expect(editor?.render(80).join('\n')).not.toContain('reviewer');
    expect(railRenderer?.(80).join('\n')).toContain('reviewer');
    handlers.get('session_shutdown')![0]!({}, context);
    expect(railRenderer).toBeUndefined();
  });

  it('renders completion notices as one bounded summary line by default', () => {
    const messageRenderers = new Map<string, CompletionRenderer>();
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn((name, renderer) => messageRenderers.set(name, renderer)),
      registerShortcut: vi.fn(),
    };
    registerLocalSubagentNavigator(pi as never, navigatorHost(() => []));
    const renderer = messageRenderers.get(SUBAGENT_COMPLETION_MESSAGE_TYPE)!;
    const notice: SubagentCompletionNotice = {
      deliveryId: 'delivery-1',
      parentSessionId: 'parent-1',
      agentId: '844e8bcc-1c51-40f5-8ef0-791604e69f58',
      type: 'explore',
      status: 'completed',
      summary: '\u001b[31m## Summary\u0007\u0008 heading\u001b[0m\nsecond detail\nthird detail\nfourth detail',
    };
    const message = {
      role: 'custom',
      customType: SUBAGENT_COMPLETION_MESSAGE_TYPE,
      content: `Subagent completion: ${notice.summary}`,
      display: true,
      details: { notice },
      timestamp: 1,
    };

    const collapsed = renderer(message, { expanded: false, outputPad: 1 }, theme)!.render(60);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toContain('Subagent explore completed');
    expect(collapsed[0]).toContain('Summary heading');
    expect(collapsed.join('\n')).not.toContain('second detail');
    expect(collapsed.join('\n')).not.toContain('\u001b[31m');
    expect(collapsed.join('\n')).not.toMatch(/[\u0007\u0008\u009B]/u);
    expect(collapsed.every((line) => visibleWidth(line) <= 60)).toBe(true);

    const expanded = renderer(message, { expanded: true, outputPad: 1 }, theme)!.render(60);
    expect(expanded.join('\n')).toContain('second detail');
    expect(expanded.join('\n')).toContain('third detail');
    expect(expanded.join('\n')).not.toContain('fourth detail');
    expect(expanded.join('\n')).toContain('1 more lines');
    expect(expanded.every((line) => visibleWidth(line) <= 60)).toBe(true);
  });

  it('renders batched completion notices as one bounded summary', () => {
    const messageRenderers = new Map<string, CompletionRenderer>();
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn((name, renderer) => messageRenderers.set(name, renderer)),
      registerShortcut: vi.fn(),
    };
    registerLocalSubagentNavigator(pi as never, navigatorHost(() => []));
    const renderer = messageRenderers.get(SUBAGENT_COMPLETION_MESSAGE_TYPE)!;
    const notices: SubagentCompletionNotice[] = [
      {
        deliveryId: 'delivery-one',
        parentSessionId: 'parent-1',
        agentId: '11111111-1111-1111-1111-111111111111',
        type: 'explore',
        status: 'completed',
        summary: 'first result',
      },
      {
        deliveryId: 'delivery-two',
        parentSessionId: 'parent-1',
        agentId: '22222222-2222-2222-2222-222222222222',
        type: 'reviewer',
        status: 'completed',
        summary: 'second result',
      },
    ];
    const message = {
      role: 'custom' as const,
      customType: SUBAGENT_COMPLETION_MESSAGE_TYPE,
      content: 'Subagent completions',
      display: true,
      details: { notices },
      timestamp: 1,
    };

    const collapsed = renderer(message, { expanded: false, outputPad: 1 }, theme)!.render(60);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toContain('2 subagents completed');
    expect(collapsed.every((line) => visibleWidth(line) <= 60)).toBe(true);

    const expanded = renderer(message, { expanded: true, outputPad: 1 }, theme)!.render(60);
    expect(expanded.join('\n')).toContain('first result');
    expect(expanded.join('\n')).toContain('second result');
    expect(expanded.every((line) => visibleWidth(line) <= 60)).toBe(true);
  });
});

type CompletionRenderer = (
  message: {
    role: 'custom';
    customType: string;
    content: string;
    display: boolean;
    details: { notice?: SubagentCompletionNotice; notices?: readonly SubagentCompletionNotice[] };
    timestamp: number;
  },
  options: { expanded: boolean; outputPad: number },
  theme: Theme,
) => Component | undefined;

function createHarness(initialRecords: LocalSubagentView[], rows = 14, columns = 80) {
  let records = initialRecords;
  const tui = {
    terminal: { rows, columns },
    requestRender: vi.fn(),
  };
  const host = navigatorHost(() => records);
  const done = vi.fn();
  const navigator = new AgentNavigator(
    tui as never,
    host,
    theme,
    { matches: () => false } as unknown as KeybindingsManager,
    done,
  );
  navigator.focused = true;
  return {
    navigator,
    tui,
    host,
    done,
    setRecords(next: LocalSubagentView[]) {
      records = next;
    },
  };
}

function navigatorHost(records: () => LocalSubagentView[]): LocalSubagentNavigatorHost {
  return {
    listLocalSubagents: vi.fn(() => records()),
    getLocalSubagent: vi.fn((agentId: string) => (
      records().find((candidate) => candidate.agentId === agentId)
    )),
    steer: vi.fn(async (agentId: string) => ({
      ok: true as const,
      value: records().find((candidate) => candidate.agentId === agentId)!,
    })),
    cancel: vi.fn(async (agentId: string) => ({
      ok: true as const,
      value: records().find((candidate) => candidate.agentId === agentId)!,
    })),
  };
}

class TestTerminal implements Terminal {
  readonly columns = 80;
  readonly rows = 12;
  readonly kittyProtocolActive = false;
  #onInput?: (data: string) => void;

  start(onInput: (data: string) => void): void { this.#onInput = onInput; }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  send(data: string): void { this.#onInput?.(data); }
}

function record(
  agentId: string,
  status: LocalSubagentView['status'] = 'running',
  overrides: Partial<LocalSubagentView> = {},
): LocalSubagentView {
  return {
    agentId,
    parentSessionId: 'root',
    rootSessionId: 'root',
    type: 'reviewer',
    description: `agent ${agentId}`,
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

function sessionWithMessages(
  messages: unknown[],
  capture: (listener: (event: unknown) => void) => void,
  options: {
    definition?: ToolDefinition<any, any, any>;
    model?: { provider: string; id: string };
    unsubscribes?: Array<ReturnType<typeof vi.fn>>;
  } = {},
): AgentSession {
  return {
    messages,
    ...(options.model === undefined ? {} : { model: options.model }),
    state: { streamingMessage: undefined, pendingToolCalls: new Set() },
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      capture(listener);
      const unsubscribe = vi.fn();
      options.unsubscribes?.push(unsubscribe);
      return unsubscribe;
    }),
    settingsManager: {
      getGlobalSettings: vi.fn(() => ({})),
      getHideThinkingBlock: vi.fn(() => false),
      setHideThinkingBlock: vi.fn(),
      getShowImages: vi.fn(() => false),
      getImageWidthCells: vi.fn(() => 40),
    },
    sessionManager: {
      getCwd: vi.fn(() => process.cwd()),
      getBranch: vi.fn(() => []),
      buildContextEntries: vi.fn(() => []),
    },
    getToolDefinition: vi.fn(() => options.definition),
  } as unknown as AgentSession;
}

function assistantToolCall(id: string, name: string, arguments_: unknown): unknown {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: arguments_ }],
    api: 'test',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: 1,
  };
}

function assistantThinking(thinking: string): unknown {
  return {
    ...assistantToolCall('unused', 'read', {}),
    content: [{ type: 'thinking', thinking }],
    stopReason: 'stop',
  };
}

function toolDefinition(name: string): ToolDefinition<any, any, any> {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {} } as never,
    execute: async () => ({ content: [] }),
  };
}

function sessionWithStreamingText(text: string): AgentSession {
  return {
    messages: [],
    state: {
      streamingMessage: {
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
      pendingToolCalls: new Set(),
    },
  } as unknown as AgentSession;
}
