import { homedir } from 'node:os';
import type { SessionEntry, SessionManager, SessionTreeNode } from '@earendil-works/pi-coding-agent';
import { stopReasonOf, type OperationResult } from '@felan-ai/session-protocol';
import { boundedText } from './projection.js';

type TreeEntry = OperationResult<'session.tree'>['entries'][number];
type ToolCall = { name: string; arguments: unknown };

const maxTextBytes = 16_384;

/** Entries are emitted in Pi's tree order (roots, then children sorted by timestamp) so clients render the same rows. */
export function projectTreeEntries(manager: SessionManager): TreeEntry[] {
  const calls = toolCalls(manager.getEntries());
  const result: TreeEntry[] = [];
  const stack = [...manager.getTree()].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    result.push(treeEntry(manager, node, calls));
    for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]!);
  }
  return result;
}

function toolCalls(entries: readonly SessionEntry[]): Map<string, ToolCall> {
  const calls = new Map<string, ToolCall>();
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant' || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (block.type === 'toolCall') calls.set(block.id, { name: block.name, arguments: block.arguments });
    }
  }
  return calls;
}

function treeEntry(manager: SessionManager, node: SessionTreeNode, calls: ReadonlyMap<string, ToolCall>): TreeEntry {
  const entry = node.entry;
  const parent = entry.parentId && entry.parentId !== entry.id && manager.getEntry(entry.parentId) ? entry.parentId : undefined;
  const labelTimestamp = node.labelTimestamp ? Date.parse(node.labelTimestamp) : NaN;
  const { role, title, stopReason, errorMessage } = display(entry, calls);
  return {
    id: entry.id,
    ...(parent ? { parent } : {}),
    kind: entry.type,
    ...(role ? { role } : {}),
    ...(node.label ? { label: node.label } : {}),
    ...(Number.isFinite(labelTimestamp) ? { labelTimestamp: Math.max(0, labelTimestamp) } : {}),
    ...(title ? { title: boundedText(title, maxTextBytes) } : {}),
    summary: boundedText(summary(entry), maxTextBytes),
    timestamp: Math.max(0, Date.parse(entry.timestamp) || 0),
    ...(stopReason ? { stopReason } : {}),
    ...(errorMessage ? { errorMessage: boundedText(errorMessage, maxTextBytes) } : {}),
  };
}

function display(entry: SessionEntry, calls: ReadonlyMap<string, ToolCall>): {
  role?: string | undefined; title?: string | undefined; stopReason?: TreeEntry['stopReason']; errorMessage?: string | undefined;
} {
  switch (entry.type) {
    case 'message': {
      const message = entry.message;
      if (message.role === 'toolResult') {
        const call = calls.get(message.toolCallId);
        return { role: message.role, title: call ? formatToolCall(call.name, call.arguments) : message.toolName || 'tool' };
      }
      if (message.role === 'assistant') {
        return { role: message.role, stopReason: stopReasonOf(message.stopReason), errorMessage: message.errorMessage };
      }
      return { role: message.role };
    }
    case 'custom_message': return { title: entry.customType };
    case 'compaction': return { title: `compaction: ${Math.round(entry.tokensBefore / 1000)}k tokens` };
    case 'model_change': return { title: `model: ${entry.modelId}` };
    case 'thinking_level_change': return { title: `thinking: ${entry.thinkingLevel}` };
    case 'custom': return { title: `custom: ${entry.customType}` };
    case 'context_edit': return { title: `context ${entry.replacement === null ? 'omit' : 'replace'}: ${entry.targetId}` };
    case 'label': return { title: `label: ${entry.label ?? '(cleared)'}` };
    case 'session_info': return { title: `title: ${entry.name || 'empty'}` };
    default: return {};
  }
}

function summary(entry: SessionEntry): string {
  switch (entry.type) {
    case 'message':
      if (entry.message.role === 'bashExecution') return entry.message.command;
      return 'content' in entry.message ? textOf(entry.message.content) : '';
    case 'custom_message': return textOf(entry.content);
    case 'compaction':
    case 'branch_summary': return entry.summary;
    default: return '';
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string' ? part.text : '').join('');
}

/** Mirrors Pi's tool-call labels; the client adds the surrounding brackets. */
function formatToolCall(name: string, value: unknown): string {
  const args = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const shortenPath = (path: string) => {
    const home = homedir();
    return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  };
  switch (name) {
    case 'read': {
      const offset = args.offset as number | undefined; const limit = args.limit as number | undefined;
      let display = shortenPath(String(args.path || args.file_path || ''));
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        const end = limit !== undefined ? start + limit - 1 : '';
        display += `:${start}${end ? `-${end}` : ''}`;
      }
      return `read: ${display}`;
    }
    case 'write': return `write: ${shortenPath(String(args.path || args.file_path || ''))}`;
    case 'edit': return `edit: ${shortenPath(String(args.path || args.file_path || ''))}`;
    case 'bash': {
      const raw = String(args.command || '');
      return `bash: ${raw.replace(/[\n\t]/gu, ' ').trim().slice(0, 50)}${raw.length > 50 ? '...' : ''}`;
    }
    case 'grep': return `grep: /${String(args.pattern || '')}/ in ${shortenPath(String(args.path || '.'))}`;
    case 'find': return `find: ${String(args.pattern || '')} in ${shortenPath(String(args.path || '.'))}`;
    case 'ls': return `ls: ${shortenPath(String(args.path || '.'))}`;
    default: {
      const json = JSON.stringify(value) ?? '';
      return `${name}: ${json.slice(0, 40)}${json.length > 40 ? '...' : ''}`;
    }
  }
}
