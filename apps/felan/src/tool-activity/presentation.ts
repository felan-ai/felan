import {
  stripTerminalSequences,
  truncateToWidth,
  type Component,
} from '@earendil-works/pi-tui';
import type {
  Theme,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  type ToolActivityCall,
  ToolActivityState,
} from './state.js';

const PREVIEW_LINES = 3;
const MAX_PREVIEW_WIDTH = 120;
const INLINE_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/gu;
const MULTILINE_CONTROL_CHARACTERS = /[\u0000-\u0009\u000B-\u000C\u000E-\u001F\u007F-\u009F]/gu;
const PROCESS_ACTION_LABELS = new Map<string, readonly [string, string, string]>([
  ['list_background_bash', ['Listing processes', 'Listed processes', 'Failed to list processes']],
  ['read_background_bash', ['Reading process output', 'Read process output', 'Failed to read process output']],
  ['wait_background_bash', ['Waiting for process', 'Waited for process', 'Failed to wait for process']],
  ['stop_background_bash', ['Stopping process', 'Stopped process', 'Failed to stop process']],
  ['write_background_bash', ['Sending input to process', 'Sent input to process', 'Failed to send input to process']],
]);
const SESSION_MEMORY_PATH_PATTERN = /(?:^|[\\/\s"'=])\.memory(?:[\\/]|$)/u;
const CANONICAL_MEMORY_PATH_PATTERN = /(?:^|[\\/])memory[\\/]v1[\\/]projects[\\/][a-f0-9]{64}[\\/]current(?:[\\/]|$)/iu;
const READ_COMMANDS = new Set([
  'cat', 'find', 'grep', 'head', 'ls', 'rg', 'sed', 'stat', 'tail', 'wc',
]);
const READ_COMMAND_AUXILIARIES = new Set([
  ':', '[', 'cd', 'echo', 'export', 'false', 'printf', 'pwd', 'set', 'test', 'true', 'unset',
]);

type ToolRenderContext = Parameters<
  NonNullable<ToolDefinition<any, any, any>['renderCall']>
>[2];

class EmptyComponent implements Component {
  render(): string[] {
    return [];
  }

  invalidate(): void {}
}

class ToolActivityGroupComponent implements Component {
  #cached: { width: number; text: string; lines: string[] } | undefined;
  #groupCache: { callIds: string[]; calls: Array<ToolCallPresentation | undefined>; inspectorHintEnabled: boolean; text: string } | undefined;

  constructor(
    private readonly state: ToolActivityState,
    private readonly groupId: string,
    private readonly theme: Theme,
    private readonly expanded: boolean,
    private readonly outputPad: number,
  ) {}

  render(width: number): string[] {
    const callIds = this.state.group(this.groupId)?.callIds ?? [];
    const calls = callIds.map((id) => { const call = this.state.call(id); return call ? toolCallPresentation(call) : undefined; });
    const cache = this.#groupCache;
    if (!cache || cache.inspectorHintEnabled !== this.state.inspectorHintEnabled || cache.callIds.length !== callIds.length
      || callIds.some((id, index) => cache.callIds[index] !== id || cache.calls[index] !== calls[index])) {
      this.#groupCache = { callIds: [...callIds], calls, inspectorHintEnabled: this.state.inspectorHintEnabled,
        text: renderToolActivityGroup(this.state, this.groupId, this.theme, this.expanded) };
    }
    const text = this.#groupCache!.text;
    if (this.#cached?.width === width && this.#cached.text === text) return this.#cached.lines;
    const padding = Math.min(Math.max(0, this.outputPad), Math.max(0, width - 1));
    const availableWidth = Math.max(1, width - padding * 2);
    const leftPadding = ' '.repeat(padding);
    // Every frame renders the whole transcript; truncating each tool line again dominated frame time.
    this.#cached = { width, text, lines: text.split('\n').map((line) => leftPadding + truncateToWidth(line, availableWidth, '…')) };
    return this.#cached.lines;
  }

  invalidate(): void {
    this.#cached = undefined;
    this.#groupCache = undefined;
  }
}

export function createToolActivityDisplayDefinition(
  state: ToolActivityState,
  toolName: string,
  original: ToolDefinition<any, any, any>,
): ToolDefinition<any, any, any> {
  return {
    ...original,
    renderShell: 'self',
    renderCall(args, theme, context) {
      state.observeRendererCall(context.toolCallId, toolName, args);
      state.registerRenderer(context.toolCallId, context.invalidate);
      const placement = state.placement(context.toolCallId);
      if (!placement?.anchor) return empty(context);
      return new ToolActivityGroupComponent(state, placement.groupId, theme, context.expanded, context.outputPad);
    },
    renderResult(_result, _options, _theme, context) {
      state.registerRenderer(context.toolCallId, context.invalidate);
      return empty(context);
    },
  };
}

export function renderToolActivityGroup(
  state: ToolActivityState,
  groupId: string,
  theme: Theme,
  expanded: boolean,
): string {
  const group = state.group(groupId);
  if (!group) return theme.fg('warning', 'Tool activity unavailable');
  const calls = group.callIds
    .map((callId) => state.call(callId))
    .filter((call): call is ToolActivityCall => call !== undefined);
  if (calls.length === 0) return theme.fg('warning', 'Tool activity unavailable');

  const summary = toolGroupSummary(calls);
  const status = groupStatus(calls, theme);
  const metadata = groupMetadata(calls);
  const inspectHint = expanded && state.inspectorHintEnabled ? ' · Alt+T full details' : '';
  const header = `${status} ${theme.bold(summary)}${theme.fg('muted', `${metadata ? ` · ${metadata}` : ''}${inspectHint}`)}`;
  const lines = [header];
  for (const call of calls) {
    lines.push(`  ${callStatus(call, theme)} ${toolCallLabel(call)}`);
    if (expanded) {
      const previews = toolCallPresentation(call).previews ??= resultPreview(call);
      for (const preview of previews) lines.push(theme.fg('dim', `      ${preview}`));
    }
  }
  return lines.join('\n');
}

export function toolCallLabel(call: ToolActivityCall): string {
  return toolCallPresentation(call).label;
}

interface ToolCallPresentation extends ToolActivityCall {
  readonly label: string;
  readonly category: ToolCategory;
  previews?: string[];
}

const callPresentations = new WeakMap<ToolActivityCall, ToolCallPresentation>();

function toolCallPresentation(call: ToolActivityCall): ToolCallPresentation {
  const cached = callPresentations.get(call);
  // State replaces field values in place, so call identity alone cannot validate a cached row; args and results are
  // compared by identity, so they must be replaced rather than mutated.
  if (cached && cached.name === call.name && cached.args === call.args && cached.status === call.status
    && cached.isError === call.isError && cached.isPartial === call.isPartial && cached.result === call.result
    && cached.relatedCommand === call.relatedCommand && cached.startedAt === call.startedAt
    && cached.completedAt === call.completedAt) return cached;
  const label = callLabel(call);
  const preview = resultChoicePreview(call) ?? argumentPreview(call);
  const presentation = { ...call, label: preview ? `${label} · ${preview}` : label, category: summaryCategory(call) };
  callPresentations.set(call, presentation);
  return presentation;
}

function resultChoicePreview(call: ToolActivityCall): string | undefined {
  if (call.name.toLowerCase() !== 'exit_plan_mode' || call.status !== 'completed') return undefined;
  const decision = asRecord(call.result?.details).decision;
  if (decision === 'approved') return 'Approve plan';
  if (decision === 'feedback') return 'Provide feedback';
  if (decision === 'cancelled') return 'Cancel Prewalk';
  return undefined;
}

export function toolGroupSummary(calls: readonly ToolActivityCall[]): string {
  const running = calls.some((call) => call.status === 'pending' || call.status === 'running');
  const counts = new Map<ToolCategory, number>();
  for (const call of calls) {
    const category = toolCallPresentation(call).category;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const parts = Array.from(counts, ([category, count]) => categorySummary(category, count, running));
  if (parts.length === 1) return capitalize(parts[0]!);
  if (parts.length === 2) return capitalize(`${parts[0]} and ${parts[1]}`);
  const remaining = Array.from(counts.values()).slice(2).reduce((total, count) => total + count, 0);
  return capitalize(`${parts[0]}, ${parts[1]}, and ${remaining} more action${remaining === 1 ? '' : 's'}`);
}

function empty(context: ToolRenderContext): Component {
  return context.lastComponent instanceof EmptyComponent ? context.lastComponent : new EmptyComponent();
}

function groupStatus(calls: readonly ToolActivityCall[], theme: Theme): string {
  if (calls.some((call) => call.isError)) return theme.fg('error', '✗');
  if (calls.some((call) => call.status === 'pending' || call.status === 'running')) {
    return theme.fg('warning', '◌');
  }
  return theme.fg('success', '✓');
}

function callStatus(call: ToolActivityCall, theme: Theme): string {
  if (call.isError) return theme.fg('error', '✗');
  if (call.status === 'pending' || call.status === 'running') return theme.fg('warning', '◌');
  return theme.fg('success', '✓');
}

function groupMetadata(calls: readonly ToolActivityCall[]): string {
  const details: string[] = [];
  const failures = calls.filter((call) => call.isError).length;
  const running = calls.filter((call) => call.status === 'pending' || call.status === 'running').length;
  if (failures > 0) details.push(`${failures} failed`);
  if (running > 0) details.push(`${running} running`);
  if (failures === 0 && running === 0) {
    const duration = groupDuration(calls);
    if (duration) details.push(duration);
  }
  return details.join(' · ');
}

function groupDuration(calls: readonly ToolActivityCall[]): string | undefined {
  if (calls.some((call) => call.startedAt === undefined || call.completedAt === undefined)) return undefined;
  const startedAt = Math.min(...calls.map((call) => call.startedAt!));
  const completedAt = Math.max(...calls.map((call) => call.completedAt!));
  return formatDuration(completedAt - startedAt);
}

function formatDuration(durationMs: number): string | undefined {
  if (durationMs <= 0) return undefined;
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1).replace(/\.0$/, '')}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function resultPreview(call: ToolActivityCall): string[] {
  if (call.name.toLowerCase() === 'list_subagents' && !call.isError) return [];
  const text = call.result?.content
    .filter((content) => content.type === 'text' && content.text)
    .map((content) => safeMultilineText(content.text!))
    .join('\n')
    .trim();
  const images = call.result?.content.filter((content) => content.type === 'image') ?? [];
  if (!text) {
    return images.length === 0
      ? []
      : images.slice(0, PREVIEW_LINES).map((image) => (
        `[${truncate(oneLine(image.mimeType ?? 'image') || 'image', MAX_PREVIEW_WIDTH)}]`
      ));
  }

  const allLines = text.split('\n').map((line) => truncate(line.trimEnd(), MAX_PREVIEW_WIDTH));
  let lines = allLines.slice(0, PREVIEW_LINES);
  const category = toolCategory(call.name);
  if ((category === 'command' || category === 'process') && allLines.length > PREVIEW_LINES) {
    lines = [...allLines.slice(0, PREVIEW_LINES - 1), allLines.at(-1)!];
  }
  if (allLines.length > PREVIEW_LINES) lines.push(`… ${allLines.length - PREVIEW_LINES} more lines`);
  return lines;
}

type ToolCategory =
  | 'memory'
  | 'skill'
  | 'read'
  | 'search'
  | 'edit'
  | 'command'
  | 'process'
  | 'wait'
  | 'interact'
  | 'task'
  | 'web'
  | 'mcp'
  | 'delegate'
  | 'other';

function summaryCategory(call: ToolActivityCall): ToolCategory {
  if (isMemoryRecall(call)) return 'memory';
  if (skillReadReference(call)) return 'skill';
  if (!call.name.toLowerCase().includes('write_stdin')) return toolCategory(call.name);
  const chars = asRecord(call.args).chars;
  return typeof chars === 'string' && chars.length > 0 ? 'interact' : 'wait';
}

function toolCategory(name: string): ToolCategory {
  const normalized = name.toLowerCase();
  if (normalized === 'mcp' || normalized.startsWith('mcp__')) return 'mcp';
  if (normalized === 'read' || normalized === 'read_file') return 'read';
  if (['web_search', 'fetch_content'].includes(normalized)) return 'web';
  if (['grep', 'find', 'ls'].includes(normalized) || normalized.includes('search')) return 'search';
  if (PROCESS_ACTION_LABELS.has(normalized)) return 'process';
  if (
    normalized === 'bash'
    || normalized.includes('exec_command')
    || normalized.includes('write_stdin')
    || normalized.includes('background_bash')
  ) return 'command';
  if (normalized.includes('edit') || normalized.includes('write') || normalized.includes('patch')) return 'edit';
  if (normalized.startsWith('task')) return 'task';
  if (normalized === 'agent' || normalized.includes('subagent')) return 'delegate';
  return 'other';
}

function categorySummary(category: ToolCategory, count: number, running: boolean): string {
  const plural = count === 1 ? '' : 's';
  switch (category) {
    case 'memory': return count === 1
      ? `${running ? 'recalling' : 'recalled'} memory`
      : `${running ? 'running' : 'completed'} ${count} memory recalls`;
    case 'skill': return count === 1
      ? `${running ? 'loading' : 'loaded'} skill`
      : `${running ? 'loading' : 'loaded'} ${count} skill files`;
    case 'read': return `${running ? 'reading' : 'read'} ${count} file${plural}`;
    case 'search': return count === 1
      ? `${running ? 'searching' : 'searched'} code`
      : `${running ? 'running' : 'ran'} ${count} searches`;
    case 'edit': return `${running ? 'editing' : 'edited'} ${count} file${plural}`;
    case 'command': return `${running ? 'running' : 'ran'} ${count} command${plural}`;
    case 'process': return `${running ? 'running' : 'completed'} ${count} process action${plural}`;
    case 'wait': return `${running ? 'waiting' : 'waited'} for ${count} command${plural}`;
    case 'interact': return `${running ? 'interacting' : 'interacted'} with ${count} command${plural}`;
    case 'task': return `${running ? 'updating' : 'updated'} ${count} task action${plural}`;
    case 'web': return `${running ? 'researching' : 'completed'} ${count} web action${plural}`;
    case 'mcp': return `${running ? 'running' : 'completed'} ${count} MCP action${plural}`;
    case 'delegate': return `${running ? 'coordinating' : 'coordinated'} ${count} subagent action${plural}`;
    case 'other': return `${running ? 'running' : 'completed'} ${count} action${plural}`;
  }
}

function callLabel(call: ToolActivityCall): string {
  const running = call.status === 'pending' || call.status === 'running';
  const normalized = call.name.toLowerCase();
  if (isMemoryRecall(call)) return running ? 'Recalling memory' : 'Memory Recall';
  if (skillReadReference(call)) return running ? 'Loading skill' : 'Skill';
  if (normalized === 'mcp') return mcpCallLabel(call, running);
  if (normalized.startsWith('mcp__')) return running ? 'Calling MCP tool' : 'Called MCP tool';
  if (normalized === 'browser_authorize') return running ? 'Requesting browser authorization' : 'Requested browser authorization';
  if (normalized === 'read' || normalized === 'read_file') return running ? 'Reading' : 'Read';
  if (normalized === 'grep') return running ? 'Searching' : 'Searched';
  if (normalized === 'find') return running ? 'Finding files' : 'Found files';
  if (normalized === 'ls') return running ? 'Listing files' : 'Listed files';
  const processLabels = PROCESS_ACTION_LABELS.get(normalized);
  if (processLabels) return processLabels[call.isError ? 2 : running ? 0 : 1];
  if (normalized === 'bash') {
    const args = asRecord(call.args);
    if (args.background === true || args.timeout === 0 || asRecord(call.result?.details).background === true) {
      if (call.isError) return 'Failed to start background process';
      return running ? 'Starting background process' : 'Started background process';
    }
  }
  if (normalized.includes('write_stdin')) {
    const chars = asRecord(call.args).chars;
    const interacted = typeof chars === 'string' && chars.length > 0;
    if (interacted) return running ? 'Interacting with command' : 'Interacted with command';
    return running ? 'Waiting for command' : 'Waited for command';
  }
  if (toolCategory(call.name) === 'edit') return running ? 'Editing' : 'Edited';
  if (toolCategory(call.name) === 'command') return running ? 'Running command' : 'Ran command';
  if (normalized === 'web_search') return running ? 'Searching the web' : 'Searched the web';
  if (normalized === 'fetch_content') return running ? 'Fetching content' : 'Fetched content';
  if (normalized === 'agent') return running ? 'Starting subagent' : 'Started subagent';
  if (normalized === 'list_subagents') return running ? 'Listing subagents' : 'Listed subagents';
  if (normalized === 'get_subagent_result') return running ? 'Reading subagent result' : 'Read subagent result';
  if (normalized === 'steer_subagent') return running ? 'Steering subagent' : 'Steered subagent';
  if (normalized === 'cancel_subagent') return running ? 'Cancelling subagent' : 'Cancelled subagent';
  if (normalized.startsWith('task')) return formatToolName(call.name);
  return running ? `Running ${formatToolName(call.name)}` : formatToolName(call.name);
}

function mcpCallLabel(call: ToolActivityCall, running: boolean): string {
  const action = firstString(asRecord(call.args), ['action'])?.toLowerCase() ?? 'status';
  switch (action) {
    case 'status': return running ? 'Checking MCP status' : 'Checked MCP status';
    case 'reconnect': return running ? 'Reconnecting MCP server' : 'Reconnected MCP server';
    case 'list': return running ? 'Listing MCP tools' : 'Listed MCP tools';
    case 'search': return running ? 'Searching MCP tools' : 'Searched MCP tools';
    case 'describe': return running ? 'Inspecting MCP tool' : 'Inspected MCP tool';
    case 'call': return running ? 'Calling MCP tool' : 'Called MCP tool';
    case 'authenticate': return running ? 'Authenticating MCP server' : 'Authenticated MCP server';
    case 'logout': return running ? 'Logging out of MCP server' : 'Logged out of MCP server';
    default: return running ? 'Running MCP action' : 'Completed MCP action';
  }
}

function mcpArgumentPreview(args: Record<string, unknown>): string | undefined {
  const action = firstString(args, ['action'])?.toLowerCase() ?? 'status';
  const server = firstString(args, ['server']);
  if (action === 'status') return server ?? 'all servers';
  if (action === 'call' || action === 'describe') {
    return joinPreview(server, firstString(args, ['tool']));
  }
  if (action === 'search') {
    return joinPreview(server, firstString(args, ['query']));
  }
  return server;
}

function browserArgumentPreview(args: Record<string, unknown>): string | undefined {
  const operation = firstString(args, ['operation'])?.toLowerCase();
  if (operation === 'skill') {
    return joinPreview(
      operation,
      firstString(args, ['skill']),
      args.full === true ? 'full' : undefined,
    );
  }
  if (operation === 'run') {
    return joinPreview(operation, firstArrayString(args, 'args'));
  }
  return operation;
}

function browserAuthorizationArgumentPreview(args: Record<string, unknown>): string | undefined {
  return firstString(args, ['reason'])
    ? truncate(oneLine(firstString(args, ['reason'])!), 88)
    : firstString(args, ['operation']);
}

function codebaseMemoryArgumentPreview(args: Record<string, unknown>): string | undefined {
  const command = firstString(args, ['command']);
  const commandArgs = asRecord(args.arguments);
  return joinPreview(
    command,
    firstString(commandArgs, [
      'query',
      'pattern',
      'function_name',
      'qualified_name',
      'name',
      'qn_pattern',
      'name_pattern',
      'file_pattern',
      'path_filter',
    ]),
  );
}

function argumentPreview(call: ToolActivityCall): string | undefined {
  const args = asRecord(call.args);
  const normalized = call.name.toLowerCase();
  const skill = isMemoryRecall(call) ? undefined : skillReadReference(call);
  let value: string | undefined;
  if (skill) {
    value = joinPreview(skill.name, skill.file);
  } else if (normalized === 'mcp') {
    value = mcpArgumentPreview(args);
  } else if (normalized === 'browser') {
    value = browserArgumentPreview(args);
  } else if (normalized === 'browser_authorize') {
    value = browserAuthorizationArgumentPreview(args);
  } else if (normalized === 'codebase_memory') {
    value = codebaseMemoryArgumentPreview(args);
  } else if (normalized.startsWith('mcp__')) {
    value = formatToolName(call.name);
  } else if (normalized === 'apply_patch') {
    value = patchPathPreview(firstString(args, ['input', 'patchText', 'patch']));
  } else if (['read', 'read_file', 'edit', 'write', 'view_image'].includes(normalized)) {
    value = firstString(args, ['path', 'file_path']);
  } else if (normalized === 'grep') {
    value = firstString(args, ['pattern']);
  } else if (normalized === 'find') {
    value = firstString(args, ['pattern', 'path']);
  } else if (normalized === 'ls') {
    value = firstString(args, ['path']);
  } else if (PROCESS_ACTION_LABELS.has(normalized)) {
    value = normalized === 'list_background_bash'
      ? firstString(args, ['status']) ?? 'all'
      : call.relatedCommand ?? firstString(args, ['id']);
  } else if (normalized.includes('write_stdin')) {
    value = call.relatedCommand ?? firstString(args, ['cmd', 'command']);
  } else if (toolCategory(call.name) === 'command') {
    value = firstString(args, ['cmd', 'command', 'id']);
  } else if (normalized.startsWith('task')) {
    const resultTask = asRecord(asRecord(call.result?.details).task);
    value = normalized === 'taskupdate'
      ? firstString(resultTask, ['title']) ?? firstString(args, ['title', 'task_id', 'view'])
      : firstString(args, ['title', 'task_id', 'view']);
  } else if (normalized === 'web_search') {
    value = firstString(args, ['query']) ?? firstArrayString(args, 'queries');
  } else if (normalized === 'fetch_content') {
    value = firstString(args, ['url']) ?? firstArrayString(args, 'urls');
  } else if (normalized === 'agent') {
    value = joinPreview(
      firstString(args, ['description']),
      firstString(args, ['subagent_type']),
    );
  } else if (normalized === 'list_subagents') {
    value = args.include_descendants === true ? 'including descendants' : undefined;
  } else if (['get_subagent_result', 'steer_subagent', 'cancel_subagent'].includes(normalized)) {
    value = firstString(args, ['agent_id']);
  } else {
    value = firstString(args, ['description', 'query', 'path', 'name', 'id']);
  }
  return value ? truncate(oneLine(value), 88) : undefined;
}

function patchPathPreview(patch: string | undefined): string | undefined {
  if (!patch) return undefined;
  const paths = Array.from(
    patch.matchAll(/^\*\*\* (?:(?:Add|Delete|Update) File|Move to): (.+)$/gmu),
    (match) => match[1]!.trim(),
  ).filter((path, index, all) => path.length > 0 && all.indexOf(path) === index);
  return paths.length > 0 ? paths.join(', ') : undefined;
}

function isMemoryRecall(call: ToolActivityCall): boolean {
  const normalized = call.name.toLowerCase();
  const args = asRecord(call.args);
  if (['read', 'read_file', 'grep', 'find', 'ls'].includes(normalized)) {
    return isMemoryPath(firstString(args, ['path', 'file_path']));
  }
  if (normalized !== 'bash' && !normalized.includes('exec_command')) return false;
  const command = firstString(args, ['cmd', 'command']);
  return command !== undefined && readOnlyCommandPath(command, isMemoryPath) !== undefined;
}

function isMemoryPath(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.startsWith('@') ? value.slice(1) : value;
  return SESSION_MEMORY_PATH_PATTERN.test(normalized) || CANONICAL_MEMORY_PATH_PATTERN.test(normalized);
}

interface SkillReference {
  readonly name: string;
  readonly file?: string;
}

function skillReadReference(call: ToolActivityCall): SkillReference | undefined {
  const normalized = call.name.toLowerCase();
  const args = asRecord(call.args);
  if (['read', 'read_file', 'grep', 'find', 'ls'].includes(normalized)) {
    return skillReference(firstString(args, ['path', 'file_path']));
  }
  if (normalized !== 'bash' && !normalized.includes('exec_command')) return undefined;
  const command = firstString(args, ['cmd', 'command']);
  return command === undefined
    ? undefined
    : skillReference(readOnlyCommandPath(command, (path) => skillReference(path) !== undefined));
}

function skillReference(value: string | undefined): SkillReference | undefined {
  if (!value) return undefined;
  const path = (value.startsWith('@') ? value.slice(1) : value).replace(/\\/gu, '/');
  const parts = path.split('/');
  if (parts.includes('..')) return undefined;
  const match = path.match(/(?:^|\/)\.agents\/skills\/([^/]+)(?:\/(.*))?$/u);
  const name = match ? match[1] : parts.at(-1) === 'SKILL.md' ? parts.at(-2) : undefined;
  if (!name || name === '.') return undefined;
  const file = match?.[2];
  return file && file !== 'SKILL.md' ? { name, file } : { name };
}

interface ParsedShellCommand {
  readonly name: string;
  readonly args: readonly string[];
}

function readOnlyCommandPath(command: string, isPath: (path: string) => boolean): string | undefined {
  if (/`|\$\(|\$\{|\$[A-Za-z_]|[<>]\(/u.test(command)) return undefined;
  const withoutNullRedirects = command.replace(/(?:\d+|&)?\s*>\s*\/dev\/null\b/giu, '');
  if (withoutNullRedirects.includes('>')) return undefined;
  const commands = shellCommands(withoutNullRedirects);
  if (commands.length === 0) return undefined;
  if (commands.some(({ name }) => !READ_COMMANDS.has(name) && !READ_COMMAND_AUXILIARIES.has(name))) {
    return undefined;
  }
  if (/\bfind\b[^;&|\n]*(?:-delete|-exec(?:dir)?|-f(?:print0?|ls)|-ok(?:dir)?)/iu.test(command)) return undefined;
  if (/\bsed\b[^;&|\n]*(?:\s-(?:[a-z]*i|i[a-z]*)\b|\s--in-place\b)/iu.test(command)) return undefined;
  const paths = commands.filter(({ name }) => READ_COMMANDS.has(name))
    .map((read) => readOperand(read, isPath));
  return paths.every((path) => path !== undefined) ? paths[0] : undefined;
}

function shellCommands(command: string): ParsedShellCommand[] {
  return shellCommandSegments(command)
    .map(parseShellCommand)
    .filter((parsed): parsed is ParsedShellCommand => parsed !== undefined);
}

function shellCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let comment = false;
  const append = () => {
    if (current.trim()) segments.push(current);
    current = '';
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (comment) {
      if (character === '\n') {
        append();
        comment = false;
      }
      continue;
    }
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      current += character;
      quote = character;
      continue;
    }
    if (character === '#' && (current.length === 0 || /\s/u.test(current.at(-1)!))) {
      comment = true;
      continue;
    }
    if (';&|()\n'.includes(character)) {
      append();
      continue;
    }
    current += character;
  }
  if (quote || escaped) return [];
  append();
  return segments;
}

function parseShellCommand(segment: string): ParsedShellCommand | undefined {
  const words = shellWords(segment);
  for (let index = 0; index < words.length; index += 1) {
    const token = words[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) continue;
    const normalized = token.split(/[\\/]/u).at(-1)!.toLowerCase();
    if (['!', 'builtin', 'command', 'do', 'elif', 'else', 'if', 'then'].includes(normalized)) continue;
    if (['done', 'fi'].includes(normalized)) return { name: 'true', args: [] };
    return { name: normalized, args: words.slice(index + 1) };
  }
  return undefined;
}

function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = '';
  let started = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const append = () => {
    if (started) words.push(current);
    current = '';
    started = false;
  };
  for (const character of segment) {
    if (escaped) {
      current += character;
      started = true;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) append();
    else {
      current += character;
      started = true;
    }
  }
  append();
  return words;
}

function readOperand(command: ParsedShellCommand, isPath: (path: string) => boolean): string | undefined {
  const positionals = command.args.filter((argument) => argument !== '--' && !argument.startsWith('-'));
  let paths: readonly string[];
  if (command.name === 'grep' || command.name === 'rg') {
    if (command.args.some((argument) => argument.startsWith('-') && !/^-[FHiLlnsvwx]+$/u.test(argument))) {
      return undefined;
    }
    paths = positionals.slice(1);
  } else if (command.name === 'sed') {
    if (command.args.some((argument) => argument.startsWith('-') && !['-n', '--quiet', '--silent'].includes(argument))) {
      return undefined;
    }
    const program = positionals[0];
    if (!program || !/^(?:(?:\d+|\$)(?:,(?:\d+|\$))?)?p$/u.test(program)) return undefined;
    paths = positionals.slice(1);
  } else if (command.name === 'find') {
    const expression = command.args.findIndex((argument) => argument.startsWith('-') || ['!', '('].includes(argument));
    paths = command.args.slice(0, expression < 0 ? command.args.length : expression);
  } else if (command.name === 'head' || command.name === 'tail') {
    paths = command.args.filter((argument, index) => argument !== '--' && !argument.startsWith('-')
      && !['-n', '-c'].includes(command.args[index - 1] ?? ''));
  } else {
    paths = positionals;
  }
  return paths.length > 0 && paths.every(isPath) ? paths[0] : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function firstArrayString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0].trim() || undefined : undefined;
}

function joinPreview(...parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return present.length > 0 ? present.join(' · ') : undefined;
}

function formatToolName(name: string): string {
  return oneLine(name)
    .replace(/^mcp__/, '')
    .replace(/__/g, ' · ')
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim() || 'Tool';
}

function oneLine(value: string): string {
  return stripTerminalSequences(value)
    .replace(INLINE_CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeMultilineText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/\r\n?/g, '\n')
    .replace(MULTILINE_CONTROL_CHARACTERS, ' ');
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
