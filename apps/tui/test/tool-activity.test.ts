import {
  initTheme,
  SessionManager,
  ToolExecutionComponent,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type Theme,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Text, visibleWidth } from '@earendil-works/pi-tui';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createToolActivityExtension,
  TOOL_ACTIVITY_SHORTCUT,
} from '../src/tool-activity/extension.js';
import { ToolActivityInspector } from '../src/tool-activity/inspector.js';
import {
  createToolActivityDisplayDefinition,
  renderToolActivityGroup,
} from '../src/tool-activity/presentation.js';
import {
  createToolActivitySessionView,
  createToolActivityRuntimeView,
  registerToolActivitySession,
} from '../src/tool-activity/runtime-view.js';
import { ToolActivityState } from '../src/tool-activity/state.js';

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

beforeAll(() => initTheme('dark', false));

describe('ToolActivityState', () => {
  it('derives adjacent groups and preserves visible transcript boundaries', () => {
    const harness = activityHarness([
      assistant([
        toolCall('read-1', 'read', { path: 'src/a.ts' }),
        toolCall('grep-1', 'grep', { pattern: 'needle' }),
      ], 10),
      toolResult('read-1', 'read', 'alpha\nbeta', false, 20),
      toolResult('grep-1', 'grep', 'src/a.ts:1:needle', false, 25),
      assistant([
        { type: 'thinking', thinking: 'A visible reasoning boundary' },
        toolCall('exec-1', 'exec_command', { cmd: 'pnpm test' }),
      ], 30),
      toolResult('exec-1', 'exec_command', 'ok', false, 40),
      assistant([
        toolCall('agent-1', 'Agent', { description: 'Review this' }),
        toolCall('task-1', 'TaskList', { view: 'current' }),
      ], 50),
    ]);

    expect(harness.state.groups().map((group) => group.callIds)).toEqual([
      ['read-1', 'grep-1'],
      ['exec-1', 'agent-1', 'task-1'],
    ]);
    expect(harness.state.group('exec-1')?.standalone).toBe(false);
    expect(harness.state.call('grep-1')).toMatchObject({ status: 'completed', isError: false });
  });

  it('groups MCP and subagent activity across adjacent tool-only turns', () => {
    const harness = activityHarness([
      assistant([toolCall('mcp-1', 'mcp', { action: 'list', server: 'linear' })], 10),
      toolResult('mcp-1', 'mcp', 'tools', false, 20),
      assistant([toolCall('mcp-2', 'mcp', { action: 'call', server: 'linear', tool: 'get_issue' })], 30),
      toolResult('mcp-2', 'mcp', 'issue', false, 40),
      assistant([
        { type: 'text', text: 'Delegating next.' },
        toolCall('agent-1', 'Agent', { description: 'Review auth', subagent_type: 'reviewer' }),
        toolCall('result-1', 'get_subagent_result', { agent_id: 'agent-123' }),
      ], 50),
    ]);

    expect(harness.state.groups().map((group) => group.callIds)).toEqual([
      ['mcp-1', 'mcp-2'],
      ['agent-1', 'result-1'],
    ]);
  });

  it('updates a live group before transcript listeners and splits rich image calls', () => {
    const harness = activityHarness([]);
    const streaming = assistant([], 10);
    harness.emit({ type: 'message_start', message: streaming });
    streaming.content = [
      toolCall('read-1', 'read', { path: 'src/a.ts' }),
      toolCall('read-2', 'read', { path: 'image.png' }),
    ];
    harness.emit(messageUpdate(streaming));

    expect(harness.state.groups().map((group) => group.callIds)).toEqual([
      ['read-1', 'read-2'],
    ]);

    harness.emit({
      type: 'tool_execution_end',
      toolCallId: 'read-2',
      toolName: 'read',
      result: { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
      isError: false,
    });

    expect(harness.state.groups().map((group) => group.callIds)).toEqual([
      ['read-1'],
      ['read-2'],
    ]);
    expect(harness.state.group('read-2')?.standalone).toBe(true);
  });

  it('links live write_stdin calls to their original command', () => {
    const harness = activityHarness([]);
    const execMessage = assistant([
      toolCall('exec-1', 'exec_command', { cmd: 'pnpm test' }),
    ], 10);
    harness.emit({ type: 'message_start', message: execMessage });
    harness.emit({
      type: 'tool_execution_end',
      toolCallId: 'exec-1',
      toolName: 'exec_command',
      result: {
        content: [{ type: 'text', text: 'Process running with session ID 59967' }],
        details: { session_id: 59967 },
      },
      isError: false,
    });
    harness.emit({ type: 'message_end', message: execMessage });

    const pollMessage = assistant([
      { type: 'thinking', thinking: 'Wait for completion.' },
      toolCall('poll-1', 'write_stdin', { session_id: 59967 }),
    ], 20);
    harness.emit({ type: 'message_start', message: pollMessage });

    expect(harness.state.call('poll-1')?.relatedCommand).toBe('pnpm test');
    const output = renderToolActivityGroup(harness.state, 'poll-1', theme, false);
    expect(output).toContain('Waiting for 1 command');
    expect(output).toContain('Waiting for command · pnpm test');
    expect(output).not.toContain('59967');
  });

  it('restores command links after an aborted exec_command continues in the background', () => {
    const harness = activityHarness([
      assistant([toolCall('exec-1', 'exec_command', { cmd: 'pnpm test' })], 10),
      toolResult(
        'exec-1',
        'exec_command',
        'exec_command aborted; process continues as session 59967',
        true,
        20,
      ),
      assistant([toolCall('poll-1', 'write_stdin', { session_id: 59967 })], 30),
    ]);

    expect(harness.state.call('poll-1')?.relatedCommand).toBe('pnpm test');
  });

  it('keeps restored command links stable when session IDs are reused', () => {
    const harness = activityHarness([
      assistant([toolCall('exec-1', 'exec_command', { cmd: 'first command' })], 10),
      toolResult('exec-1', 'exec_command', 'Process running with session ID 59967', false, 20),
      assistant([
        { type: 'thinking', thinking: 'Poll the first command.' },
        toolCall('poll-1', 'write_stdin', { session_id: 59967 }),
      ], 30),
      toolResult('poll-1', 'write_stdin', 'Process exited with code 0', false, 40),
      assistant([
        { type: 'thinking', thinking: 'Start another command.' },
        toolCall('exec-2', 'exec_command', { cmd: 'second command' }),
      ], 50),
      toolResult('exec-2', 'exec_command', 'Process running with session ID 59967', false, 60),
      assistant([
        { type: 'thinking', thinking: 'Poll the second command.' },
        toolCall('poll-2', 'write_stdin', { session_id: 59967 }),
      ], 70),
    ]);

    expect(harness.state.call('poll-1')?.relatedCommand).toBe('first command');
    expect(harness.state.call('poll-2')?.relatedCommand).toBe('second command');
  });
});

describe('tool activity rendering', () => {
  it('renders one-line action rows, bounded previews, and no rows for non-anchor calls', () => {
    const harness = activityHarness([
      assistant([
        toolCall('read-1', 'read', { path: 'src/a.ts' }),
        toolCall('grep-1', 'grep', { pattern: 'needle' }),
      ], 10),
      toolResult('read-1', 'read', 'line 1\u0007\nline 2\nline 3\nline 4\nline 5', false, 20),
      toolResult('grep-1', 'grep', 'match', false, 25),
    ]);
    const definition = createToolActivityDisplayDefinition(harness.state, 'read', toolDefinition('read'));
    const grepDefinition = createToolActivityDisplayDefinition(harness.state, 'grep', toolDefinition('grep'));
    const anchor = definition.renderCall!({ path: 'src/a.ts' }, theme, renderContext('read-1', false));
    const hidden = grepDefinition.renderCall!({ pattern: 'needle' }, theme, renderContext('grep-1', false));
    const collapsed = anchor.render(100).join('\n');

    expect(collapsed).toContain('Read 1 file and searched code');
    expect(collapsed).toContain('  ✓ Read · src/a.ts');
    expect(collapsed).toContain('  ✓ Searched · needle');
    expect(collapsed).not.toContain('line 1');
    expect(hidden.render(100)).toEqual([]);
    expect(anchor.render(36).every((line) => visibleWidth(line) <= 36)).toBe(true);

    const expanded = definition.renderCall!(
      { path: 'src/a.ts' },
      theme,
      renderContext('read-1', true, anchor),
    ).render(100).join('\n');
    expect(expanded).toContain('line 1');
    expect(expanded).toContain('… 2 more lines');
    expect(expanded).not.toContain('line 4');
    expect(expanded).not.toContain('\u0007');
    expect(expanded).toContain('Alt+T full details');
  });

  it('summarizes grouped MCP and subagent calls without raw arguments or results', () => {
    const mcpHarness = activityHarness([
      assistant([
        toolCall('mcp-1', 'mcp', {
          action: 'search',
          server: 'linear',
          query: 'auth\u0007\u0008 bugs',
        }),
        toolCall('mcp-2', 'mcp', {
          action: 'call',
          server: 'linear',
          tool: 'get_issue',
          args: { secret: 'do-not-render' },
        }),
      ], 10),
      toolResult('mcp-1', 'mcp', 'search result that stays collapsed', false, 20),
      toolResult('mcp-2', 'mcp', 'call result that stays collapsed', false, 25),
    ]);
    const mcpOutput = renderToolActivityGroup(mcpHarness.state, 'mcp-1', theme, false);

    expect(mcpOutput).toContain('Completed 2 MCP actions');
    expect(mcpOutput).toContain('Searched MCP tools · linear · auth bugs');
    expect(mcpOutput).toContain('Called MCP tool · linear · get_issue');
    expect(mcpOutput).not.toMatch(/[\u0000-\u0009\u000B-\u000C\u000E-\u001F\u007F-\u009F]/u);
    expect(mcpOutput).not.toContain('do-not-render');
    expect(mcpOutput).not.toContain('search result that stays collapsed');

    const subagentHarness = activityHarness([
      assistant([
        toolCall('agent-1', 'Agent', {
          description: 'Review auth',
          subagent_type: 'reviewer',
          prompt: 'long prompt that must not render',
        }),
        toolCall('list-1', 'list_subagents', { include_descendants: true }),
        toolCall('result-1', 'get_subagent_result', { agent_id: 'agent-123' }),
        toolCall('steer-1', 'steer_subagent', {
          agent_id: 'agent-123',
          message: 'long guidance that must not render',
        }),
        toolCall('cancel-1', 'cancel_subagent', {
          agent_id: 'agent-456',
          reason: 'private reason that must not render',
        }),
      ], 30),
      toolResult('agent-1', 'Agent', 'queued', false, 40),
      toolResult('list-1', 'list_subagents', 'records', false, 41),
      toolResult('result-1', 'get_subagent_result', 'long child result that must stay collapsed', false, 45),
      toolResult('steer-1', 'steer_subagent', 'queued', false, 46),
      toolResult('cancel-1', 'cancel_subagent', 'cancelled', false, 47),
    ]);
    const subagentOutput = renderToolActivityGroup(subagentHarness.state, 'agent-1', theme, false);

    expect(subagentOutput).toContain('Coordinated 5 subagent actions');
    expect(subagentOutput).toContain('Started subagent · Review auth · reviewer');
    expect(subagentOutput).toContain('Listed subagents · including descendants');
    expect(subagentOutput).toContain('Read subagent result · agent-123');
    expect(subagentOutput).toContain('Steered subagent · agent-123');
    expect(subagentOutput).toContain('Cancelled subagent · agent-456');
    expect(subagentOutput).not.toContain('long prompt');
    expect(subagentOutput).not.toContain('long guidance');
    expect(subagentOutput).not.toContain('private reason');
    expect(subagentOutput).not.toContain('long child result');
  });

  it('shows failures in the group summary', () => {
    const harness = activityHarness([
      assistant([toolCall('exec-1', 'exec_command', { cmd: 'false' })], 10),
      toolResult('exec-1', 'exec_command', 'Command exited with code 1', true, 20),
    ]);

    expect(renderToolActivityGroup(harness.state, 'exec-1', theme, false)).toContain('1 failed');
  });

  it('renders the original command for write_stdin calls instead of the session ID', () => {
    const harness = activityHarness([
      assistant([toolCall('exec-1', 'exec_command', { cmd: 'pnpm test' })], 10),
      toolResult(
        'exec-1',
        'exec_command',
        'Process running with session ID 59967',
        false,
        20,
      ),
      assistant([
        { type: 'thinking', thinking: 'Wait for completion.' },
        toolCall('poll-1', 'write_stdin', { session_id: 59967 }),
      ], 30),
      toolResult('poll-1', 'write_stdin', 'Process exited with code 0', false, 40, { exit_code: 0 }),
    ]);

    const output = renderToolActivityGroup(harness.state, 'poll-1', theme, false);
    expect(output).toContain('Waited for 1 command');
    expect(output).toContain('Waited for command · pnpm test');
    expect(output).not.toContain('59967');
  });

  it('does not expose an unresolved write_stdin session ID', () => {
    const harness = activityHarness([
      assistant([toolCall('poll-1', 'write_stdin', { session_id: 59967 })], 10),
      toolResult('poll-1', 'write_stdin', 'Unknown process id 59967', true, 20),
    ]);

    expect(renderToolActivityGroup(harness.state, 'poll-1', theme, false)).not.toContain('59967');
  });

  it('renders a completed TaskUpdate with the task title instead of its ID', () => {
    const harness = activityHarness([
      assistant([
        toolCall('task-update-1', 'TaskUpdate', {
          task_id: 'T-AAAAAA',
          status: 'in_progress',
        }),
      ], 10),
      toolResult(
        'task-update-1',
        'TaskUpdate',
        'Updated T-AAAAAA: Implement feature',
        false,
        20,
        { task: { id: 'T-AAAAAA', title: 'Implement feature' } },
      ),
    ]);

    const output = renderToolActivityGroup(harness.state, 'task-update-1', theme, false);
    expect(output).toContain('TaskUpdate · Implement feature');
    expect(output).not.toContain('T-AAAAAA');
  });

  it('suppresses Pi fallback output while retaining bounded expansion', () => {
    const harness = activityHarness([
      assistant([toolCall('read-1', 'read', { path: 'src/a.ts' })], 10),
      toolResult('read-1', 'read', 'line 1\nline 2\nline 3\nline 4', false, 20),
    ]);
    const definition = createToolActivityDisplayDefinition(harness.state, 'read', toolDefinition('read'));
    const component = new ToolExecutionComponent(
      'read',
      'read-1',
      { path: 'src/a.ts' },
      {},
      definition,
      { requestRender: vi.fn() } as never,
      '/workspace',
    );
    component.updateResult({
      content: [{ type: 'text', text: 'raw fallback output that must stay hidden' }],
      isError: false,
    });

    expect(component.render(100).join('\n')).not.toContain('raw fallback output');
    component.setExpanded(true);
    const expanded = component.render(100).join('\n');
    expect(expanded).toContain('line 1');
    expect(expanded).not.toContain('line 4');
  });
});

describe('tool activity runtime view', () => {
  it('decorates definitions only through the interactive session view', () => {
    const original = toolDefinition('read');
    const state = new ToolActivityState('grouped');
    const session = {
      getToolDefinition: () => original,
      exportedDefinition() {
        return this.getToolDefinition('read');
      },
    } as unknown as AgentSession & { exportedDefinition(): ToolDefinition };
    const runtime = { session } as unknown as AgentSessionRuntime;
    registerToolActivitySession(session, state);

    const view = createToolActivityRuntimeView(runtime);

    expect(view.session.getToolDefinition('read')).not.toBe(original);
    expect(view.session.getToolDefinition('read')?.renderShell).toBe('self');
    expect((view.session as typeof session).exportedDefinition()).toBe(original);
    expect(runtime.session.getToolDefinition('read')).toBe(original);

    const childState = new ToolActivityState('grouped');
    const childView = createToolActivitySessionView(session, childState);
    expect(childView.getToolDefinition('read')).not.toBe(original);
    expect(childView.getToolDefinition('read')?.renderShell).toBe('self');
    childState.dispose();
  });

  it('preserves original definitions in full mode', () => {
    const original = toolDefinition('read');
    const state = new ToolActivityState('full');
    const session = { getToolDefinition: () => original } as unknown as AgentSession;
    const runtime = { session } as unknown as AgentSessionRuntime;
    registerToolActivitySession(session, state);

    expect(createToolActivityRuntimeView(runtime).session.getToolDefinition('read')).toBe(original);
    expect(createToolActivitySessionView(session, state).getToolDefinition('read')).toBe(original);
  });

  it('does not reuse a child session view after its state is disposed', () => {
    const original = toolDefinition('read');
    const session = { getToolDefinition: () => original } as unknown as AgentSession;
    const firstState = new ToolActivityState('grouped');
    const firstView = createToolActivitySessionView(session, firstState);
    firstState.dispose();

    const secondState = new ToolActivityState('grouped');
    const secondView = createToolActivitySessionView(session, secondState);

    expect(secondView).not.toBe(firstView);
    expect(secondView.getToolDefinition('read')).not.toBe(original);
    secondState.dispose();
  });
});

describe('ToolActivityInspector', () => {
  it('shows full arguments and results and closes cleanly', () => {
    const harness = activityHarness([
      assistant([toolCall('read-1', 'read', { path: 'src/a.ts', apiKey: 'do-not-render' })], 10),
      toolResult('read-1', 'read', 'one\ntwo\nthree\nfour\nfive', false, 20),
    ]);
    harness.state.rememberDefinition('read', {
      ...toolDefinition('read'),
      renderCall: () => new Text('Specialized read view', 0, 0),
      renderResult: () => new Text('Specialized result view', 0, 0),
    });
    const done = vi.fn();
    const inspector = new ToolActivityInspector(
      harness.state,
      theme,
      { terminal: { rows: 30 }, requestRender: vi.fn() } as never,
      done,
    );

    const output = inspector.render(100).join('\n');
    expect(output).toContain('Specialized read view');
    expect(output).toContain('Specialized result view');
    expect(output).toContain('"path": "src/a.ts"');
    expect(output).toContain('"apiKey": "[redacted]"');
    expect(output).not.toContain('do-not-render');
    inspector.handleInput('\x1b[F');
    expect(inspector.render(100).join('\n')).toContain('five');
    expect(inspector.render(50).every((line) => visibleWidth(line) <= 50)).toBe(true);

    inspector.handleInput('q');
    inspector.handleInput('q');
    expect(done).toHaveBeenCalledOnce();
  });
});

describe('tool activity extension', () => {
  it('registers hidden local inspector controls', async () => {
    const registerCommand = vi.fn();
    const registerShortcut = vi.fn();
    const extension = createToolActivityExtension(new ToolActivityState('grouped'));

    await extension.factory({
      registerCommand,
      registerShortcut,
      on: vi.fn(),
    } as never);

    expect(extension.hidden).toBe(true);
    expect(registerCommand).toHaveBeenCalledWith('tools', expect.any(Object));
    expect(registerShortcut).toHaveBeenCalledWith(TOOL_ACTIVITY_SHORTCUT, expect.any(Object));
  });
});

function activityHarness(messages: ReturnType<typeof assistant | typeof toolResult>[]) {
  const sessionManager = SessionManager.inMemory('/workspace');
  for (const message of messages) sessionManager.appendMessage(message as never);
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const session = {
    sessionManager,
    state: {
      streamingMessage: undefined,
      pendingToolCalls: new Set<string>(),
    },
    subscribe(next: (event: AgentSessionEvent) => void) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  } as unknown as AgentSession;
  const state = new ToolActivityState('grouped');
  state.attach(session);
  return {
    state,
    emit(event: AgentSessionEvent) {
      listener?.(event);
    },
  };
}

function assistant(content: Array<Record<string, unknown>>, timestamp: number) {
  return {
    role: 'assistant' as const,
    content,
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
    stopReason: 'toolUse' as const,
    timestamp,
  };
}

function toolCall(id: string, name: string, args: unknown) {
  return { type: 'toolCall', id, name, arguments: args };
}

function toolResult(
  toolCallId: string,
  toolName: string,
  text: string,
  isError: boolean,
  timestamp: number,
  details?: unknown,
) {
  return {
    role: 'toolResult' as const,
    toolCallId,
    toolName,
    content: [{ type: 'text' as const, text }],
    details,
    isError,
    timestamp,
  };
}

function messageUpdate(message: ReturnType<typeof assistant>): AgentSessionEvent {
  return {
    type: 'message_update',
    message: message as never,
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '' } as never,
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

function renderContext(
  toolCallId: string,
  expanded: boolean,
  lastComponent?: unknown,
) {
  return {
    args: {},
    toolCallId,
    invalidate: vi.fn(),
    lastComponent,
    state: {},
    cwd: '/workspace',
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded,
    showImages: false,
    isError: false,
  } as never;
}
