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
  toolCallLabel,
  toolGroupSummary,
} from '../src/tool-activity/presentation.js';
import {
  createToolActivitySessionView,
  createToolActivityRuntimeView,
  registerToolActivitySession,
} from '../src/tool-activity/runtime-view.js';
import { ToolActivityState, type ToolActivityCall } from '../src/tool-activity/state.js';

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

  it('links live background process controls to their originating Bash command', () => {
    const harness = activityHarness([]);
    const id = 'bash-20260909062731-45ad69';
    harness.emit({
      type: 'message_start',
      message: assistant([toolCall('start', 'bash', { command: 'pnpm verify', background: true })], 10),
    });
    harness.emit({
      type: 'tool_execution_end',
      toolCallId: 'start',
      toolName: 'bash',
      result: { content: [], details: { background: true, id, command: 'pnpm verify' } },
      isError: false,
    });
    harness.emit({
      type: 'message_start',
      message: assistant([
        { type: 'text', text: 'Inspect output.' },
        toolCall('output', 'read_background_bash', { id }),
      ], 20),
    });

    expect(harness.state.call('output')?.relatedCommand).toBe('pnpm verify');
    const output = renderToolActivityGroup(harness.state, 'output', theme, false);
    expect(output).toContain('Reading process output · pnpm verify');
    expect(output).not.toContain(id);
  });

  it('restores background command links when the launch is outside retained context', () => {
    const id = 'bash-20260909062731-45ad69';
    const harness = activityHarness([
      assistant([toolCall('start', 'bash', { command: 'pnpm verify', timeout: 0 })], 10),
      toolResult('start', 'bash', 'started', false, 20, { background: true, id }),
      assistant([toolCall('output', 'read_background_bash', { id })], 30),
      toolResult('output', 'read_background_bash', 'passed', false, 40, { id }),
    ]);
    const retained = harness.session.sessionManager.buildContextEntries().slice(2);
    vi.spyOn(harness.session.sessionManager, 'buildContextEntries').mockReturnValue(retained);
    harness.state.rebuild();

    expect(harness.state.call('start')).toBeUndefined();
    expect(harness.state.call('output')?.relatedCommand).toBe('pnpm verify');
    expect(renderToolActivityGroup(harness.state, 'output', theme, false))
      .toContain('Read process output · pnpm verify');
  });

  it('learns commands from process lists and structured control results', () => {
    const id = 'bash-20260909062731-45ad69';
    const otherId = 'bash-20260909062732-45ad70';
    const harness = activityHarness([
      assistant([toolCall('list', 'list_background_bash', {})], 10),
      toolResult('list', 'list_background_bash', 'jobs', false, 20, {
        jobs: [{ meta: { id, command: 'pnpm dev' }, status: { status: 'running' } }],
      }),
      assistant([toolCall('output', 'read_background_bash', { id })], 30),
      toolResult('output', 'read_background_bash', 'ready', false, 40, { id }),
      assistant([toolCall('wait', 'wait_background_bash', { id: otherId })], 50),
      toolResult('wait', 'wait_background_bash', 'done', false, 60, {
        job: { meta: { id: otherId, command: 'pnpm test' }, status: { status: 'completed' } },
      }),
    ]);

    expect(harness.state.call('output')?.relatedCommand).toBe('pnpm dev');
    expect(harness.state.call('wait')?.relatedCommand).toBe('pnpm test');
  });

  it('ignores malformed process metadata instead of rendering raw result fields', () => {
    const id = 'bash-20260909062731-45ad69';
    const harness = activityHarness([
      assistant([toolCall('list', 'list_background_bash', {})], 10),
      toolResult('list', 'list_background_bash', 'jobs', false, 20, {
        jobs: [null, 42, { meta: null }, { meta: { id, command: { private: 'hidden' } } }],
      }),
      assistant([toolCall('output', 'read_background_bash', { id })], 30),
      toolResult('output', 'read_background_bash', 'output', false, 40),
    ]);

    expect(harness.state.call('output')?.relatedCommand).toBeUndefined();
    const output = renderToolActivityGroup(harness.state, 'list', theme, false);
    expect(output).toContain(`Read process output · ${id}`);
    expect(output).not.toContain('hidden');
  });
});

describe('tool activity rendering', () => {
  it.each([
    ['status', (call: ToolActivityCall) => { call.status = 'running'; }, 'Waiting for command'],
    ['result', (call: ToolActivityCall) => { call.result = { content: [{ type: 'text', text: 'updated output' }] }; }, 'updated output'],
    ['args', (call: ToolActivityCall) => { call.args = { chars: 'y', cmd: 'interactive command' }; }, 'Interacted with command · interactive command'],
    ['relatedCommand', (call: ToolActivityCall) => { call.relatedCommand = 'linked command'; }, 'Waited for command · linked command'],
    ['isError', (call: ToolActivityCall) => { call.isError = true; }, '✗ Waited for command'],
    ['name', (call: ToolActivityCall) => { call.name = 'read'; call.args = { path: 'other.ts' }; }, 'Read · other.ts'],
    ['startedAt', (call: ToolActivityCall) => { call.startedAt = 5; }, '15ms'],
    ['completedAt', (call: ToolActivityCall) => { call.completedAt = 25; }, '15ms'],
  ])('refreshes cached group %s without invalidation', (_field, change, expected) => {
    const args = { cmd: 'initial command' };
    const harness = activityHarness([
      assistant([toolCall('call-1', 'write_stdin', args)], 10),
      toolResult('call-1', 'write_stdin', 'original output', false, 20),
    ]);
    const definition = createToolActivityDisplayDefinition(harness.state, 'write_stdin', toolDefinition('write_stdin'));
    const component = definition.renderCall!(args, theme, renderContext('call-1', true));
    const before = component.render(200).join('\n');

    change(harness.state.call('call-1')!);

    const after = component.render(200).join('\n');
    expect(after).not.toBe(before);
    expect(after).toContain(expected);
    expect(after).toBe(renderToolActivityGroup(harness.state, 'call-1', theme, true).split('\n').map((line) => ` ${line}`).join('\n'));
  });

  it('refreshes cached membership and order without invalidation', () => {
    const args = { path: 'a.ts' };
    const harness = activityHarness([
      assistant([toolCall('read-1', 'read', args), toolCall('read-2', 'read', { path: 'b.ts' })], 10),
      toolResult('read-1', 'read', 'first', false, 20),
      toolResult('read-2', 'read', 'second', false, 20),
    ]);
    const definition = createToolActivityDisplayDefinition(harness.state, 'read', toolDefinition('read'));
    const component = definition.renderCall!(args, theme, renderContext('read-1', false));
    const callIds = harness.state.group('read-1')!.callIds as string[];
    expect(component.render(200).join('\n')).toContain('Read 2 files');
    callIds.reverse();
    expect(component.render(200)[1]).toContain('b.ts');
    callIds.pop();
    expect(component.render(200).join('\n')).toContain('Read 1 file');
    expect(component.render(200).join('\n')).not.toContain('a.ts');
    callIds.push('read-1');
    expect(component.render(200).join('\n')).toContain('Read 2 files');
  });

  it('refreshes expansion, theme and inspector hints without invalidation', () => {
    const args = { path: 'a.ts' };
    const harness = activityHarness([
      assistant([toolCall('read-1', 'read', args)], 10),
      toolResult('read-1', 'read', 'preview', false, 20),
    ]);
    const definition = createToolActivityDisplayDefinition(harness.state, 'read', toolDefinition('read'));
    const collapsed = definition.renderCall!(args, theme, renderContext('read-1', false));
    expect(collapsed.render(200).join('\n')).not.toContain('preview');
    const expanded = definition.renderCall!(args, theme, renderContext('read-1', true, collapsed));
    expect(expanded.render(200).join('\n')).toContain('preview');
    expect(expanded.render(200).join('\n')).toContain('Alt+T full details');
    vi.spyOn(harness.state, 'inspectorHintEnabled', 'get').mockReturnValue(false);
    expect(expanded.render(200).join('\n')).not.toContain('Alt+T full details');
    const otherTheme = { fg: (color: string, text: string) => `[${color}:${text}]`, bold: (text: string) => `<${text}>` } as Theme;
    const themed = definition.renderCall!(args, otherTheme, renderContext('read-1', true, expanded));
    expect(themed.render(200).join('\n')).toContain('[success:✓] <Read 1 file>');
    expect(themed.render(200).join('\n')).toContain('[dim:      preview]');
    expect(definition.renderCall!(args, otherTheme, renderContext('read-1', false, themed)).render(200).join('\n')).not.toContain('preview');
  });

  it('does not repeat command analysis or labels for unchanged calls or recreated components', () => {
    const command = vi.fn(() => 'cat /agent/.memory/index.md');
    const path = vi.fn(() => 'a.ts');
    const args = { get command() { return command(); } };
    const harness = activityHarness([
      assistant([toolCall('bash-1', 'bash', args), toolCall('read-1', 'read', { get path() { return path(); } })], 10),
      toolResult('bash-1', 'bash', 'index', false, 20),
      toolResult('read-1', 'read', 'file', false, 20),
    ]);
    const definition = createToolActivityDisplayDefinition(harness.state, 'bash', toolDefinition('bash'));
    const component = definition.renderCall!(args, theme, renderContext('bash-1', false));
    component.render(200);
    expect(command).toHaveBeenCalled();
    expect(path).toHaveBeenCalled();
    command.mockClear(); path.mockClear();
    for (let frame = 0; frame < 5; frame += 1) component.render(200);
    component.render(100);
    component.invalidate(); component.render(200);
    toolCallLabel(harness.state.call('bash-1')!);
    toolGroupSummary(harness.state.calls());
    expect(command).not.toHaveBeenCalled();
    expect(path).not.toHaveBeenCalled();

    const recreated = definition.renderCall!(args, theme, renderContext('bash-1', true, component));
    command.mockClear();
    recreated.render(200);
    expect(command).not.toHaveBeenCalled();
    expect(path).not.toHaveBeenCalled();

    harness.state.call('read-1')!.args = { path: 'changed.ts' };
    expect(recreated.render(200).join('\n')).toContain('changed.ts');
    expect(command).not.toHaveBeenCalled();
    harness.state.call('bash-1')!.args = { command: 'echo changed' };
    expect(recreated.render(200).join('\n')).toContain('Ran command · echo changed');
    expect(recreated.render(200).join('\n')).not.toContain('Memory Recall');
  });

  it('describes process actions without claiming to run new commands or exposing input', () => {
    const id = 'bash-20260909062731-45ad69';
    const harness = activityHarness([
      assistant([toolCall('start', 'bash', { command: 'pnpm verify\u001b]0;hidden\u0007', background: true })], 10),
      toolResult('start', 'bash', 'started', false, 20, { background: true, id }),
      assistant([
        { type: 'text', text: 'Manage the process.' },
        toolCall('list', 'list_background_bash', { status: 'running' }),
        toolCall('read', 'read_background_bash', { id }),
        toolCall('wait', 'wait_background_bash', { id }),
        toolCall('write', 'write_background_bash', { id, chars: 'private input\n' }),
        toolCall('stop', 'stop_background_bash', { id }),
      ], 30),
      ...['list', 'read', 'wait', 'write', 'stop'].map((action, index) => (
        toolResult(action, `${action}_background_bash`, 'private output', false, 40 + index)
      )),
    ]);
    const output = renderToolActivityGroup(harness.state, 'list', theme, false);

    expect(output).toContain('Completed 5 process actions');
    expect(output).toContain('Listed processes · running');
    expect(output).toContain('Read process output · pnpm verify');
    expect(output).toContain('Waited for process · pnpm verify');
    expect(output).toContain('Sent input to process · pnpm verify');
    expect(output).toContain('Stopped process · pnpm verify');
    expect(output).not.toMatch(/Ran command|hidden|private|\u001b|\u0007/u);
    expect(output).not.toContain(id);
    expect(renderToolActivityGroup(harness.state, 'start', theme, false))
      .toContain('Started background process · pnpm verify');
    const definition = createToolActivityDisplayDefinition(harness.state, 'list_background_bash', toolDefinition('list_background_bash'));
    const narrow = definition.renderCall!({ status: 'running' }, theme, renderContext('list', false)).render(36);
    expect(narrow.every((line) => visibleWidth(line) <= 36)).toBe(true);
  });

  it('falls back to the process ID and labels failed controls honestly', () => {
    const id = 'bash-20260909062731-45ad69';
    const harness = activityHarness([
      assistant([toolCall('stop', 'stop_background_bash', { id })], 10),
      toolResult('stop', 'stop_background_bash', 'still running', true, 20),
    ]);

    const output = renderToolActivityGroup(harness.state, 'stop', theme, false);
    expect(output).toContain(`✗ Failed to stop process · ${id}`);
    expect(output).not.toContain('Stopped process');
  });

  it('renders the current Web Access tools as web activity', () => {
    const harness = activityHarness([
      assistant([
        toolCall('web-search', 'web_search', { query: 'release notes' }),
        toolCall('web-content', 'fetch_content', { urls: ['https://example.com/docs'], findText: ['version'] }),
      ], 10),
      toolResult('web-search', 'web_search', 'results', false, 20),
      toolResult('web-content', 'fetch_content', 'passages', false, 21),
    ]);

    const output = renderToolActivityGroup(harness.state, 'web-search', theme, false);
    expect(output).toContain('Completed 2 web actions');
    expect(output).toContain('Searched the web · release notes');
    expect(output).toContain('Fetched content · https://example.com/docs');
  });

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
    const anchor = definition.renderCall!({ path: 'src/a.ts' }, theme, renderContext('read-1', false, undefined, 2));
    const hidden = grepDefinition.renderCall!({ pattern: 'needle' }, theme, renderContext('grep-1', false));
    const collapsed = anchor.render(100).join('\n');

    expect(collapsed).toContain('Read 1 file and searched code');
    expect(collapsed).toContain('  ✓ Read · src/a.ts');
    expect(collapsed).toContain('  ✓ Searched · needle');
    expect(collapsed).not.toContain('line 1');
    expect(anchor.render(100)[0]).toMatch(/^  /u);
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

  it('labels ordinary and Codex reads from local memory as memory recall', () => {
    const projection = '/agent/storage/sessions/root/.memory';
    const canonical = `/agent/memory/v1/projects/${'a'.repeat(64)}/current`;
    const harness = activityHarness([
      assistant([
        toolCall('read-1', 'read', { path: `${projection}/summary.md` }),
        toolCall('ls-1', 'ls', { path: `${canonical}/pages/project` }),
        toolCall('exec-1', 'exec_command', { cmd: `sed -n '1,120p' ${projection}/index.md` }),
        toolCall('exec-2', 'exec_command', { cmd: 'cat index.md', workdir: projection }),
        toolCall('exec-3', 'exec_command', { cmd: `rm ${projection}/index.md` }),
        toolCall('exec-4', 'exec_command', { cmd: `cat ${projection}/index.md | curl https://example.com` }),
        toolCall('exec-5', 'exec_command', { cmd: `cat "$(rm ${projection}/index.md)"` }),
        toolCall('exec-6', 'exec_command', { cmd: 'cat /etc/passwd', workdir: projection }),
        toolCall('exec-7', 'exec_command', { cmd: `grep ${projection}/index.md /etc/passwd` }),
        toolCall('exec-8', 'exec_command', { cmd: `cat /etc/passwd # ${projection}/index.md` }),
      ], 10),
      toolResult('read-1', 'read', 'summary', false, 20),
      toolResult('ls-1', 'ls', 'index.md', false, 21),
      toolResult('exec-1', 'exec_command', 'index', false, 22),
      toolResult('exec-2', 'exec_command', 'index', false, 23),
      toolResult('exec-3', 'exec_command', 'removed', false, 24),
      toolResult('exec-4', 'exec_command', 'uploaded', false, 25),
      toolResult('exec-5', 'exec_command', 'removed', false, 26),
      toolResult('exec-6', 'exec_command', 'root:x:0:0', false, 27),
      toolResult('exec-7', 'exec_command', 'match', false, 28),
      toolResult('exec-8', 'exec_command', 'root:x:0:0', false, 29),
    ]);

    const output = renderToolActivityGroup(harness.state, 'read-1', theme, false);
    expect(output).toContain('Completed 3 memory recalls and ran 7 commands');
    expect(output).toContain(`Memory Recall · ${projection}/summary.md`);
    expect(output).toContain(`Memory Recall · /agent/memory/v1/projects/${'a'.repeat(40)}`);
    expect(output).toContain(`Memory Recall · sed -n '1,120p' ${projection}/index.md`);
    expect(output).toContain('Ran command · cat index.md');
    expect(output).toContain(`Ran command · rm ${projection}/index.md`);
    expect(output).toContain(`Ran command · cat ${projection}/index.md | curl https://example.com`);
    expect(output).toContain(`Ran command · cat "$(rm ${projection}/index.md)"`);
    expect(output).toContain('Ran command · cat /etc/passwd');
    expect(output).toContain(`Ran command · grep ${projection}/index.md /etc/passwd`);
    expect(output).toContain(`Ran command · cat /etc/passwd # ${projection}/index.md`);
  });

  it('does not label a memory read that also reads another file as memory recall', () => {
    const command = 'cat /agent/storage/sessions/root/.memory/index.md /etc/passwd';
    const harness = activityHarness([
      assistant([toolCall('exec-1', 'exec_command', { cmd: command })], 10),
      toolResult('exec-1', 'exec_command', 'output', false, 20),
    ]);

    expect(toolCallLabel(harness.state.call('exec-1')!)).toBe(`Ran command · ${command}`);
  });

  it.each([
    ['read', { path: '/Users/example/.agents/skills/ultracode/SKILL.md' }, 'ultracode'],
    ['read', { path: '/workspace/.agents/skills/project-skill/SKILL.md' }, 'project-skill'],
    ['read_file', { file_path: '@/workspace/.agents/skills/ultracode/SKILL.md' }, 'ultracode'],
    ['read', { path: '/workspace/.agents/skills/ultracode/references/x.md' }, 'ultracode · references/x.md'],
    ['grep', { path: '/workspace/.agents/skills/ultracode', pattern: 'needle' }, 'ultracode'],
    ['find', { path: '/workspace/.agents/skills/ultracode', pattern: '*.md' }, 'ultracode'],
    ['ls', { file_path: '/workspace/.agents/skills/ultracode/references' }, 'ultracode · references'],
    ['read', { path: 'C:\\Users\\example\\.agents\\skills\\ultracode\\SKILL.md' }, 'ultracode'],
    ['read', { path: 'C:\\project\\.agents\\skills\\ultracode\\references\\x.md' }, 'ultracode · references/x.md'],
    ['read', { path: '/opt/custom-skills/fallback/SKILL.md' }, 'fallback'],
    ['read', { path: 'C:\\custom-skills\\fallback\\SKILL.md' }, 'fallback'],
  ])('labels skill-folder %s reads by skill name and relative file: %j', (name, args, preview) => {
    const harness = activityHarness([
      assistant([toolCall('skill-1', name, args)], 10),
      toolResult('skill-1', name, 'skill content', false, 20),
    ]);

    const output = renderToolActivityGroup(harness.state, 'skill-1', theme, false);
    expect(output).toContain('Loaded skill');
    expect(output).toContain(`  ✓ Skill · ${preview}`);
    expect(output).not.toMatch(/\/Users\/|\/workspace\/|\/opt\/|C:\\|SKILL\.md|needle/u);
  });

  it.each([
    '/workspace/.agents/skills',
    '/workspace/.agents/skills/',
    '/workspace/not.agents/skills/ultracode/references/x.md',
    '/opt/custom-skills/fallback/SKILL.md.bak',
    '/workspace/.agents/skills/ultracode/../../../etc/passwd',
    './SKILL.md',
  ])('does not treat a non-skill path as a skill: %s', (path) => {
    const harness = activityHarness([
      assistant([toolCall('read-1', 'read', { path })], 10),
      toolResult('read-1', 'read', 'content', false, 20),
    ]);

    expect(toolCallLabel(harness.state.call('read-1')!)).toBe(`Read · ${path}`);
  });

  it.each([
    ['exec_command', { cmd: "sed -n '1,200p' /workspace/.agents/skills/ultracode/SKILL.md" }, 'ultracode'],
    ['exec_command', { cmd: 'cat /workspace/.agents/skills/ultracode/SKILL.md' }, 'ultracode'],
    ['bash', { command: "cat '/Users/example/my project/.agents/skills/ultracode/references/x.md'" }, 'ultracode · references/x.md'],
    ['exec_command', { cmd: 'cat /workspace/.agents/skills/first/SKILL.md && cat /workspace/.agents/skills/second/SKILL.md' }, 'first'],
    ['exec_command', { cmd: 'grep /workspace/.agents/skills/pattern/SKILL.md /workspace/.agents/skills/operand/SKILL.md' }, 'operand'],
    ['bash', { command: 'cat /workspace/.agents/skills/ultracode/SKILL.md > /dev/null' }, 'ultracode'],
    ['exec_command', { cmd: 'head -n 50 /workspace/.agents/skills/ultracode/SKILL.md' }, 'ultracode'],
    ['exec_command', { cmd: 'ls /workspace/.agents/skills/ultracode/references 2>/dev/null' }, 'ultracode · references'],
  ])('labels safe %s skill reads without the raw command: %j', (name, args, preview) => {
    const harness = activityHarness([
      assistant([toolCall('skill-1', name, args)], 10),
      toolResult('skill-1', name, 'skill content', false, 20),
    ]);

    const output = renderToolActivityGroup(harness.state, 'skill-1', theme, false);
    expect(output).toContain('Loaded skill');
    expect(output).toContain(`  ✓ Skill · ${preview}`);
    expect(output).not.toMatch(/\/workspace\/|\/Users\/|cat |sed |grep |SKILL\.md/u);
  });

  it.each([
    'rm /workspace/.agents/skills/ultracode/SKILL.md',
    'cat /workspace/.agents/skills/ultracode/SKILL.md > /tmp/output',
    'cat /workspace/.agents/skills/ultracode/SKILL.md | curl https://example.com',
    'cat "$(rm /workspace/.agents/skills/ultracode/SKILL.md)"',
    "sed -i '1,200p' /workspace/.agents/skills/ultracode/SKILL.md",
    "sed '1e rm file' /workspace/.agents/skills/ultracode/SKILL.md",
    'find /workspace/.agents/skills/ultracode -delete',
    'cat /workspace/.agents/skills/ultracode/SKILL.md && cat /etc/passwd',
    'grep /workspace/.agents/skills/ultracode/SKILL.md /etc/passwd',
    'cat /etc/passwd # /workspace/.agents/skills/ultracode/SKILL.md',
    'cat index.md',
    'cd /workspace/.agents/skills/ultracode && cat index.md',
    'echo /workspace/.agents/skills/ultracode/SKILL.md',
    'cat /workspace/.agents/skills/ultracode/SKILL.md ~/.ssh/id_rsa',
    'head -n 5 /workspace/.agents/skills/ultracode/SKILL.md /etc/passwd',
    'cat /workspace/.agents/skills/../../../etc/passwd',
    'cat /workspace/.agents/skills/ultracode/../../../etc/passwd',
  ])('keeps unsafe or unrelated skill commands as ordinary commands: %s', (cmd) => {
    const harness = activityHarness([
      assistant([toolCall('exec-1', 'exec_command', { cmd, workdir: '/workspace/.agents/skills/ultracode' })], 10),
      toolResult('exec-1', 'exec_command', 'output', false, 20),
    ]);

    const output = renderToolActivityGroup(harness.state, 'exec-1', theme, false);
    expect(output).toContain('Ran 1 command');
    expect(output).toContain('  ✓ Ran command · ');
    expect(output).not.toContain('Skill · ');
  });

  it.each([
    ['edit', { path: '/workspace/.agents/skills/ultracode/SKILL.md' }],
    ['write', { file_path: '/workspace/.agents/skills/ultracode/SKILL.md' }],
    ['apply_patch', { input: '*** Begin Patch\n*** Update File: /workspace/.agents/skills/ultracode/SKILL.md\n@@\n-old\n+new\n*** End Patch' }],
  ])('keeps %s of skill files in the edit category', (name, args) => {
    const harness = activityHarness([
      assistant([toolCall('edit-1', name, args)], 10),
      toolResult('edit-1', name, 'updated', false, 20),
    ]);

    const output = renderToolActivityGroup(harness.state, 'edit-1', theme, false);
    expect(output).toContain('Edited 1 file');
    expect(output).toContain('  ✓ Edited · /workspace/.agents/skills/ultracode/SKILL.md');
    expect(output).not.toContain('Skill · ');
  });

  it.each([
    ['pending', 1, 'Loading skill'],
    ['running', 1, 'Loading skill'],
    ['running', 2, 'Loading 2 skill files'],
    ['completed', 1, 'Loaded skill'],
    ['completed', 2, 'Loaded 2 skill files'],
  ] as const)('summarizes %s reads of %i skill files as "%s"', (status, count, summary) => {
    const harness = activityHarness([
      assistant(Array.from({ length: count }, (_, index) => (
        toolCall(`skill-${index}`, 'read', { path: '/workspace/.agents/skills/ultracode/SKILL.md' })
      )), 10),
    ]);
    for (const call of harness.state.calls()) call.status = status;

    const output = renderToolActivityGroup(harness.state, 'skill-0', theme, false);
    expect(output).toContain(summary);
    expect(output).toContain(`${status === 'completed' ? '✓ Skill' : '◌ Loading skill'} · ultracode`);
  });

  it('joins skill and ordinary read summaries', () => {
    const harness = activityHarness([
      assistant([
        toolCall('skill-1', 'read', { path: '/workspace/.agents/skills/ultracode/SKILL.md' }),
        toolCall('read-1', 'read', { path: 'src/a.ts' }),
      ], 10),
      toolResult('skill-1', 'read', 'skill content', false, 20),
      toolResult('read-1', 'read', 'source', false, 21),
    ]);

    expect(renderToolActivityGroup(harness.state, 'skill-1', theme, false))
      .toContain('Loaded skill and read 1 file');
  });

  it('keeps memory recall precedence over skill paths', () => {
    const path = '/agent/.memory/.agents/skills/ultracode/SKILL.md';
    const harness = activityHarness([
      assistant([
        toolCall('read-1', 'read', { path }),
        toolCall('exec-1', 'exec_command', { cmd: `cat ${path}` }),
      ], 10),
      toolResult('read-1', 'read', 'memory', false, 20),
      toolResult('exec-1', 'exec_command', 'memory', false, 21),
    ]);

    const output = renderToolActivityGroup(harness.state, 'read-1', theme, false);
    expect(output).toContain('Completed 2 memory recalls');
    expect(output).toContain(`Memory Recall · ${path}`);
    expect(output).toContain(`Memory Recall · cat ${path}`);
    expect(output).not.toContain('Skill · ');
  });

  it('sanitizes and truncates skill previews', () => {
    const name = `ultra\u001b[31mcode\u001b[0m\u0007 ${'x'.repeat(100)}`;
    const harness = activityHarness([
      assistant([toolCall('skill-1', 'read', { path: `/workspace/.agents/skills/${name}/references/x.md` })], 10),
      toolResult('skill-1', 'read', 'skill content', false, 20),
    ]);

    expect(toolCallLabel(harness.state.call('skill-1')!))
      .toBe(`Skill · ultracode ${'x'.repeat(77)}…`);
  });

  it('retains bounded result previews for expanded skill reads', () => {
    const harness = activityHarness([
      assistant([toolCall('skill-1', 'read', { path: '/workspace/.agents/skills/ultracode/SKILL.md' })], 10),
      toolResult('skill-1', 'read', 'first\nsecond\nthird\nfourth', false, 20),
    ]);

    const output = renderToolActivityGroup(harness.state, 'skill-1', theme, true);
    expect(output).toContain('  ✓ Skill · ultracode');
    expect(output).toContain('      first\n      second\n      third\n      … 1 more lines');
    expect(output).not.toContain('fourth');
  });

  it.each(['running', 'completed'] as const)('hides %s list_subagents result previews even when expanded', (status) => {
    const harness = activityHarness([
      assistant([toolCall('list-1', 'list_subagents', { include_descendants: true })], 10),
      toolResult('list-1', 'list_subagents', 'private records\nagent-secret\nprivate prompt', false, 20),
    ]);
    harness.state.call('list-1')!.status = status;

    const output = renderToolActivityGroup(harness.state, 'list-1', theme, true);
    expect(output).toContain(`${status === 'running' ? 'Listing' : 'Listed'} subagents · including descendants`);
    expect(output.split('\n')).toHaveLength(2);
    expect(output).not.toMatch(/private records|agent-secret|private prompt/u);
  });

  it('retains error previews for expanded list_subagents calls', () => {
    const harness = activityHarness([
      assistant([toolCall('list-1', 'list_subagents', {})], 10),
      toolResult('list-1', 'list_subagents', 'Unable to list subagents\nConnection failed', true, 20),
    ]);

    const output = renderToolActivityGroup(harness.state, 'list-1', theme, true);
    expect(output).toContain('✗ Listed subagents');
    expect(output).toContain('      Unable to list subagents\n      Connection failed');
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

  it('shows browser operation details without exposing trailing browser arguments', () => {
    const harness = activityHarness([
      assistant([
        toolCall('browser-skill', 'browser', {
          operation: 'skill',
          skill: 'core',
          full: true,
        }),
        toolCall('browser-open', 'browser', {
          operation: 'run',
          args: ['open', 'https://example.com/?token=do-not-render'],
        }),
        toolCall('browser-fill', 'browser', {
          operation: 'run',
          args: ['fill', '@e3', 'private form value'],
        }),
      ], 10),
      toolResult('browser-skill', 'browser', 'skill', false, 20),
      toolResult('browser-open', 'browser', 'opened', false, 21),
      toolResult('browser-fill', 'browser', 'filled', false, 22),
    ]);

    const output = renderToolActivityGroup(harness.state, 'browser-skill', theme, false);
    expect(output).toContain('Browser · skill · core · full');
    expect(output).toContain('Browser · run · open');
    expect(output).toContain('Browser · run · fill');
    expect(output).not.toContain('do-not-render');
    expect(output).not.toContain('private form value');
  });

  it('shows the browser authorization reason beside the tool call', () => {
    const harness = activityHarness([
      assistant([
        toolCall('authorize', 'browser_authorize', {
          operation: 'authorize',
          origin: 'https://example.com/private',
          reason: 'Need the signed-in account to verify the private dashboard.\u001b]0;hidden\u0007',
        }),
      ], 10),
      toolResult('authorize', 'browser_authorize', 'authorized', false, 20),
    ]);

    const output = renderToolActivityGroup(harness.state, 'authorize', theme, false);
    expect(output).toContain('Requested browser authorization · Need the signed-in account to verify the private dashboard.');
    expect(output).not.toContain('example.com');
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('\u0007');
  });

  it('shows a bounded authorization reason while the call is pending', () => {
    const reason = 'x'.repeat(120);
    const harness = activityHarness([
      assistant([toolCall('authorize', 'browser_authorize', { operation: 'authorize', reason })], 10),
    ]);

    const output = renderToolActivityGroup(harness.state, 'authorize', theme, false);
    expect(output).toContain('Requesting browser authorization · ');
    expect(output).toContain(`${'x'.repeat(87)}…`);
    expect(output).not.toContain('x'.repeat(88));
  });

  it('shows the Codebase Memory command and its useful argument', () => {
    const harness = activityHarness([
      assistant([
        toolCall('cbm-search', 'codebase_memory', {
          command: 'search_graph',
          arguments: {
            query: 'authentication\u0007 flow',
            secret: 'do-not-render',
          },
        }),
        toolCall('cbm-status', 'codebase_memory', {
          command: 'index_status',
          arguments: {},
        }),
      ], 10),
      toolResult('cbm-search', 'codebase_memory', 'matches', false, 20),
      toolResult('cbm-status', 'codebase_memory', 'ready', false, 21),
    ]);

    const output = renderToolActivityGroup(harness.state, 'cbm-search', theme, false);
    expect(output).toContain('Codebase Memory · search_graph · authentication flow');
    expect(output).toContain('Codebase Memory · index_status');
    expect(output).not.toContain('do-not-render');
    expect(output).not.toMatch(/[\u0000-\u0009\u000B-\u000C\u000E-\u001F\u007F-\u009F]/u);
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

  it('shows the files touched by apply_patch', () => {
    const harness = activityHarness([
      assistant([toolCall('patch-1', 'apply_patch', {
        input: `*** Begin Patch
*** Update File: src/a.ts
*** Move to: src/renamed.ts
@@
-old
+new
*** Delete File: src/b.ts
*** Add File: src/b.ts
+content
*** End Patch`,
      })], 10),
      toolResult('patch-1', 'apply_patch', 'Applied patch successfully', false, 20),
    ]);

    const output = renderToolActivityGroup(harness.state, 'patch-1', theme, false);
    expect(output).toContain('Edited · src/a.ts, src/renamed.ts, src/b.ts');
    expect(output).not.toContain('old');
    expect(output).not.toContain('new');
    expect(output).not.toContain('content');
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

  it.each([
    ['approved', 'Approve plan'],
    ['feedback', 'Provide feedback'],
    ['cancelled', 'Cancel Prewalk'],
  ])('shows the Exit Plan Mode %s choice alongside the tool label', (decision, choice) => {
    const plan = '1. Keep this plan out of the collapsed activity row.';
    const harness = activityHarness([
      assistant([toolCall('exit-plan-mode-1', 'exit_plan_mode', { plan })], 10),
      toolResult(
        'exit-plan-mode-1',
        'exit_plan_mode',
        'Plan review completed.',
        false,
        20,
        { phase: decision === 'cancelled' ? 'idle' : 'planning', decision },
      ),
    ]);

    const output = renderToolActivityGroup(harness.state, 'exit-plan-mode-1', theme, false);
    expect(output).toContain(`  ✓ Exit Plan Mode · ${choice}`);
    expect(output).not.toContain(plan);
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
    const lines = inspector.render(100);
    expect(lines[0]).toBe('─'.repeat(100));
    expect(lines.at(-1)).toBe('─'.repeat(100));
    expect(lines.some((line) => line.startsWith('│') || line.endsWith('│'))).toBe(false);
    expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
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

  it('opens /tools inline without overlay options', async () => {
    const registerCommand = vi.fn();
    const extension = createToolActivityExtension(new ToolActivityState('grouped'));
    await extension.factory({ registerCommand, registerShortcut: vi.fn(), on: vi.fn() } as never);
    const handler = registerCommand.mock.calls[0]![1].handler as (
      args: string,
      ctx: { mode: string; ui: { custom: ReturnType<typeof vi.fn> } },
    ) => Promise<void>;
    const custom = vi.fn(async () => undefined);

    await handler('', { mode: 'tui', ui: { custom } });

    expect(custom).toHaveBeenCalledOnce();
    expect(custom.mock.calls[0]).toHaveLength(1);
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
    session,
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
  outputPad = 1,
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
    durationMs: undefined,
    outputPad,
  } as never;
}
