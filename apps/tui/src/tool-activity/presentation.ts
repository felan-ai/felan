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
  constructor(
    private readonly state: ToolActivityState,
    private readonly groupId: string,
    private readonly theme: Theme,
    private readonly expanded: boolean,
  ) {}

  render(width: number): string[] {
    return renderToolActivityGroup(this.state, this.groupId, this.theme, this.expanded)
      .split('\n')
      .map((line) => truncateToWidth(line, Math.max(1, width), '…'));
  }

  invalidate(): void {}
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
      return new ToolActivityGroupComponent(state, placement.groupId, theme, context.expanded);
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
  const inspectHint = expanded ? ' · Alt+T full details' : '';
  const header = `${status} ${theme.bold(summary)}${theme.fg('muted', `${metadata ? ` · ${metadata}` : ''}${inspectHint}`)}`;
  const lines = [header];
  for (const call of calls) {
    lines.push(`  ${callStatus(call, theme)} ${toolCallLabel(call)}`);
    if (expanded) {
      for (const preview of resultPreview(call)) lines.push(theme.fg('dim', `      ${preview}`));
    }
  }
  return lines.join('\n');
}

export function toolCallLabel(call: ToolActivityCall): string {
  const label = callLabel(call);
  const preview = argumentPreview(call);
  return preview ? `${label} · ${preview}` : label;
}

export function toolGroupSummary(calls: readonly ToolActivityCall[]): string {
  const running = calls.some((call) => call.status === 'pending' || call.status === 'running');
  const counts = new Map<ToolCategory, number>();
  for (const call of calls) {
    const category = summaryCategory(call);
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
  if (toolCategory(call.name) === 'command' && allLines.length > PREVIEW_LINES) {
    lines = [...allLines.slice(0, PREVIEW_LINES - 1), allLines.at(-1)!];
  }
  if (allLines.length > PREVIEW_LINES) lines.push(`… ${allLines.length - PREVIEW_LINES} more lines`);
  return lines;
}

type ToolCategory =
  | 'read'
  | 'search'
  | 'edit'
  | 'command'
  | 'wait'
  | 'interact'
  | 'task'
  | 'web'
  | 'mcp'
  | 'delegate'
  | 'other';

function summaryCategory(call: ToolActivityCall): ToolCategory {
  if (!call.name.toLowerCase().includes('write_stdin')) return toolCategory(call.name);
  const chars = asRecord(call.args).chars;
  return typeof chars === 'string' && chars.length > 0 ? 'interact' : 'wait';
}

function toolCategory(name: string): ToolCategory {
  const normalized = name.toLowerCase();
  if (normalized === 'mcp' || normalized.startsWith('mcp__')) return 'mcp';
  if (normalized === 'read') return 'read';
  if (['web_search', 'source_check', 'fetch_content', 'get_search_content'].includes(normalized)) return 'web';
  if (['grep', 'find', 'ls'].includes(normalized) || normalized.includes('search')) return 'search';
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
    case 'read': return `${running ? 'reading' : 'read'} ${count} file${plural}`;
    case 'search': return count === 1
      ? `${running ? 'searching' : 'searched'} code`
      : `${running ? 'running' : 'ran'} ${count} searches`;
    case 'edit': return `${running ? 'editing' : 'edited'} ${count} file${plural}`;
    case 'command': return `${running ? 'running' : 'ran'} ${count} command${plural}`;
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
  if (normalized === 'mcp') return mcpCallLabel(call, running);
  if (normalized.startsWith('mcp__')) return running ? 'Calling MCP tool' : 'Called MCP tool';
  if (normalized === 'read') return running ? 'Reading' : 'Read';
  if (normalized === 'grep') return running ? 'Searching' : 'Searched';
  if (normalized === 'find') return running ? 'Finding files' : 'Found files';
  if (normalized === 'ls') return running ? 'Listing files' : 'Listed files';
  if (normalized.includes('write_stdin')) {
    const chars = asRecord(call.args).chars;
    const interacted = typeof chars === 'string' && chars.length > 0;
    if (interacted) return running ? 'Interacting with command' : 'Interacted with command';
    return running ? 'Waiting for command' : 'Waited for command';
  }
  if (toolCategory(call.name) === 'edit') return running ? 'Editing' : 'Edited';
  if (toolCategory(call.name) === 'command') return running ? 'Running command' : 'Ran command';
  if (normalized === 'web_search') return running ? 'Searching the web' : 'Searched the web';
  if (normalized === 'source_check') return running ? 'Checking sources' : 'Checked sources';
  if (normalized === 'fetch_content') return running ? 'Fetching content' : 'Fetched content';
  if (normalized === 'get_search_content') return running ? 'Reading web content' : 'Read web content';
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

function argumentPreview(call: ToolActivityCall): string | undefined {
  const args = asRecord(call.args);
  const normalized = call.name.toLowerCase();
  let value: string | undefined;
  if (normalized === 'mcp') {
    value = mcpArgumentPreview(args);
  } else if (normalized.startsWith('mcp__')) {
    value = formatToolName(call.name);
  } else if (['read', 'edit', 'write', 'view_image'].includes(normalized)) {
    value = firstString(args, ['path', 'file_path']);
  } else if (normalized === 'grep') {
    value = firstString(args, ['pattern']);
  } else if (normalized === 'find') {
    value = firstString(args, ['pattern', 'path']);
  } else if (normalized === 'ls') {
    value = firstString(args, ['path']);
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
  } else if (normalized === 'source_check') {
    value = firstString(args, ['claim']);
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
