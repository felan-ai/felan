import type { SessionManager } from '@earendil-works/pi-coding-agent';

export interface ClassifierSessionEvidence {
  readonly conversation: ReadonlyArray<{ readonly role: 'user' | 'assistant' | 'summary'; readonly text: string }>;
  readonly tool_activity: ReadonlyArray<{
    readonly tool: string;
    readonly input: string;
    readonly result?: 'ok' | 'failed';
    readonly exit_code?: number;
    readonly task_status?: string;
  }>;
}

export interface ClassifierSessionEvidenceLimits {
  readonly maxConversationItems?: number;
  readonly maxToolActivities?: number;
  readonly maxTextBytes?: number;
  readonly maxToolInputBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxSourceEntries?: number;
}

interface ToolActivity {
  tool: string;
  input: string;
  result?: 'ok' | 'failed';
  exit_code?: number;
  task_status?: string;
}

const encoder = new TextEncoder();
const defaults = {
  maxConversationItems: 24,
  maxToolActivities: 40,
  maxTextBytes: 1_200,
  maxToolInputBytes: 160,
  maxTotalBytes: 16_384,
  maxSourceEntries: 4_096,
};

export function collectClassifierSessionEvidence(
  session: Pick<SessionManager, 'buildSessionProjection' | 'buildContextEntries'>,
  limits: ClassifierSessionEvidenceLimits = {},
): ClassifierSessionEvidence {
  const bounds = {
    maxConversationItems: bound(limits.maxConversationItems, defaults.maxConversationItems),
    maxToolActivities: bound(limits.maxToolActivities, defaults.maxToolActivities, 4_096),
    maxTextBytes: bound(limits.maxTextBytes, defaults.maxTextBytes),
    maxToolInputBytes: bound(limits.maxToolInputBytes, defaults.maxToolInputBytes),
    maxTotalBytes: bound(limits.maxTotalBytes, defaults.maxTotalBytes, 256 * 1_024),
    maxSourceEntries: bound(limits.maxSourceEntries, defaults.maxSourceEntries),
  };
  const conversation: ClassifierSessionEvidence['conversation'][number][] = [];
  const toolActivity: ToolActivity[] = [];
  const calls = new Map<string, typeof toolActivity[number]>();

  const recent = <T>(items: readonly T[]): T[] => bounds.maxSourceEntries === 0 ? [] : items.slice(-bounds.maxSourceEntries);
  const projection = typeof session.buildSessionProjection === 'function'
    ? recent(session.buildSessionProjection().entries).flatMap(({ sourceEntry, messages }): unknown[] => (
      sourceEntry.type === 'compaction' || sourceEntry.type === 'branch_summary'
        ? [{ role: 'summary', text: sourceEntry.summary }]
        : messages
    ))
    : recent(session.buildContextEntries()).flatMap((entry): unknown[] => (
      entry.type === 'compaction' || entry.type === 'branch_summary'
        ? [{ role: 'summary', text: entry.summary }]
        : entry.type === 'message' ? [entry.message] : []
    ));
  for (const message of projection) {
    if (!isRecord(message)) continue;
    if (message.role === 'summary') {
      const text = safeText(message.text, bounds.maxTextBytes);
      if (text) conversation.push({ role: 'summary', text });
      continue;
    }
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      const call = calls.get(message.toolCallId);
      if (call) {
        const exitCode = resultExitCode(message);
        call.result = message.isError === true || (exitCode !== undefined && exitCode !== 0) ? 'failed' : 'ok';
        if (exitCode !== undefined) call.exit_code = exitCode;
        const details = message.details;
        if (isRecord(details) && isRecord(details.task) && typeof details.task.status === 'string') {
          call.task_status = safeText(details.task.status, 48);
        }
      }
      continue;
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = safeText(contentText(message.content), bounds.maxTextBytes);
    if (text) conversation.push({ role: message.role, text });
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== 'toolCall' || typeof part.name !== 'string') continue;
      const call = {
        tool: safeText(part.name, 80), input: toolInput(part.arguments, bounds.maxToolInputBytes),
      } as ToolActivity;
      if (!call.tool) continue;
      toolActivity.push(call);
      if (typeof part.id === 'string') calls.set(part.id, call);
    }
  }

  let remaining = Math.max(0, bounds.maxTotalBytes - 44);
  const fit = <T>(values: T[], maxItems: number): T[] => {
    const kept: T[] = [];
    for (let index = values.length - 1; index >= 0 && kept.length < maxItems; index--) {
      const item = values[index]!;
      const size = encoder.encode(JSON.stringify(item)).byteLength;
      if (size > remaining) continue;
      remaining -= size;
      kept.push(item);
    }
    return kept.reverse();
  };
  const evidence = {
    conversation: fit(conversation, bounds.maxConversationItems),
    tool_activity: fit(toolActivity, bounds.maxToolActivities),
  };
  while (encoder.encode(JSON.stringify(evidence)).byteLength > bounds.maxTotalBytes) {
    if (evidence.tool_activity.length > 0) evidence.tool_activity.shift();
    else if (evidence.conversation.length > 0) evidence.conversation.shift();
    else break;
  }
  return evidence;
}

function toolInput(value: unknown, maxBytes: number): string {
  if (!isRecord(value)) return '';
  for (const key of ['path', 'file_path', 'command', 'pattern', 'query', 'description', 'title']) {
    if (typeof value[key] === 'string') return safeText(value[key], maxBytes);
  }
  return '';
}

function resultExitCode(message: Record<string, unknown>): number | undefined {
  const details = message.details;
  if (isRecord(details) && typeof details.exitCode === 'number' && Number.isSafeInteger(details.exitCode)) return details.exitCode;
  const text = safeText(contentText(message.content), 256);
  const match = /(?:Exit(?: code)?):\s*(\d+)/iu.exec(text);
  return match ? Number(match[1]) : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.flatMap((part): string[] => (
    isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
  )).join('\n');
}

function safeText(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || maxBytes <= 0) return '';
  let text = value.slice(0, Math.max(512, maxBytes * 8))
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+)\b/gu, '[REDACTED_TOKEN]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[REDACTED_TOKEN]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]+/giu, '$1[REDACTED_SECRET]')
    .trim();
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const codepoint of text) {
    const size = encoder.encode(codepoint).byteLength;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += codepoint.length;
  }
  text = text.slice(0, end).trimEnd();
  return text;
}

export function sanitizeClassifierText(value: unknown, maxBytes: number): string {
  return safeText(value, bound(maxBytes, 4_096, 16_384));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bound(value: number | undefined, fallback: number, maximum = fallback * 16): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, maximum) : fallback;
}
