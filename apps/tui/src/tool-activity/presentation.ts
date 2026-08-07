import {
  Text,
  stripTerminalSequences,
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

type ToolRenderContext = Parameters<
  NonNullable<ToolDefinition<any, any, any>['renderCall']>
>[2];

class EmptyComponent implements Component {
  render(): string[] {
    return [];
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
      return new Text(renderToolActivityGroup(state, placement.groupId, theme, context.expanded), 0, 0);
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
  if (!expanded) return header;

  const lines = [header];
  for (const call of calls) {
    lines.push(`  ${callStatus(call, theme)} ${toolCallLabel(call)}`);
    for (const preview of resultPreview(call)) lines.push(theme.fg('dim', `      ${preview}`));
  }
  return lines.join('\n');
}

export function toolCallLabel(call: ToolActivityCall): string {
  const label = callLabel(call);
  const preview = argumentPreview(call);
  return preview ? `${label} · ${preview}` : label;
}

export function toolGroupSummary(calls: readonly ToolActivityCall[]): string {
  if (calls.length === 1) return toolCallLabel(calls[0]!);

  const running = calls.some((call) => call.status === 'pending' || call.status === 'running');
  const counts = new Map<ToolCategory, number>();
  for (const call of calls) {
    const category = toolCategory(call.name);
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
  const details = [`${calls.length} action${calls.length === 1 ? '' : 's'}`];
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
    .map((content) => stripTerminalSequences(content.text!))
    .join('\n')
    .trim();
  const images = call.result?.content.filter((content) => content.type === 'image') ?? [];
  if (!text) {
    return images.length === 0
      ? []
      : images.slice(0, PREVIEW_LINES).map((image) => `[${image.mimeType ?? 'image'}]`);
  }

  const allLines = text.split('\n').map((line) => truncate(line.trimEnd(), MAX_PREVIEW_WIDTH));
  let lines = allLines.slice(0, PREVIEW_LINES);
  if (toolCategory(call.name) === 'command' && allLines.length > PREVIEW_LINES) {
    lines = [...allLines.slice(0, PREVIEW_LINES - 1), allLines.at(-1)!];
  }
  if (allLines.length > PREVIEW_LINES) lines.push(`… ${allLines.length - PREVIEW_LINES} more lines`);
  return lines;
}

type ToolCategory = 'read' | 'search' | 'edit' | 'command' | 'task' | 'web' | 'delegate' | 'other';

function toolCategory(name: string): ToolCategory {
  const normalized = name.toLowerCase();
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
    case 'task': return `${running ? 'updating' : 'updated'} ${count} task action${plural}`;
    case 'web': return `${running ? 'researching' : 'completed'} ${count} web action${plural}`;
    case 'delegate': return `${running ? 'coordinating' : 'completed'} ${count} agent action${plural}`;
    case 'other': return `${running ? 'running' : 'completed'} ${count} action${plural}`;
  }
}

function callLabel(call: ToolActivityCall): string {
  const running = call.status === 'pending' || call.status === 'running';
  const normalized = call.name.toLowerCase();
  if (normalized === 'read') return running ? 'Reading' : 'Read';
  if (normalized === 'grep') return running ? 'Searching' : 'Searched';
  if (normalized === 'find') return running ? 'Finding files' : 'Found files';
  if (normalized === 'ls') return running ? 'Listing files' : 'Listed files';
  if (toolCategory(call.name) === 'edit') return running ? 'Editing' : 'Edited';
  if (toolCategory(call.name) === 'command') return running ? 'Running command' : 'Ran command';
  if (normalized === 'web_search') return running ? 'Searching the web' : 'Searched the web';
  if (normalized === 'source_check') return running ? 'Checking sources' : 'Checked sources';
  if (normalized === 'fetch_content') return running ? 'Fetching content' : 'Fetched content';
  if (normalized === 'get_search_content') return running ? 'Reading web content' : 'Read web content';
  if (normalized === 'agent') return running ? 'Starting subagent' : 'Started subagent';
  if (normalized.startsWith('task')) return formatToolName(call.name);
  return running ? `Running ${formatToolName(call.name)}` : formatToolName(call.name);
}

function argumentPreview(call: ToolActivityCall): string | undefined {
  const args = asRecord(call.args);
  const normalized = call.name.toLowerCase();
  let value: string | undefined;
  if (['read', 'edit', 'write', 'view_image'].includes(normalized)) {
    value = firstString(args, ['path', 'file_path']);
  } else if (normalized === 'grep') {
    value = firstString(args, ['pattern']);
  } else if (normalized === 'find') {
    value = firstString(args, ['pattern', 'path']);
  } else if (normalized === 'ls') {
    value = firstString(args, ['path']);
  } else if (toolCategory(call.name) === 'command') {
    value = firstString(args, ['cmd', 'command', 'id', 'session_id']);
  } else if (normalized.startsWith('task')) {
    value = firstString(args, ['title', 'task_id', 'view']);
  } else if (normalized === 'web_search') {
    value = firstString(args, ['query']) ?? firstArrayString(args, 'queries');
  } else if (normalized === 'source_check') {
    value = firstString(args, ['claim']);
  } else if (normalized === 'fetch_content') {
    value = firstString(args, ['url']) ?? firstArrayString(args, 'urls');
  } else if (normalized === 'agent') {
    value = firstString(args, ['description', 'subagent_type']);
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

function formatToolName(name: string): string {
  return name
    .replace(/^mcp__/, '')
    .replace(/__/g, ' · ')
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim() || 'Tool';
}

function oneLine(value: string): string {
  return stripTerminalSequences(value).replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
