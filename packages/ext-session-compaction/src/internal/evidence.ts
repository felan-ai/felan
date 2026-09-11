import {
  DEFAULT_EXTRACTION_BOUNDS,
  emptyOmission,
  freezeOmission,
  omit,
  sanitizeText,
  stableIdentifier,
  utf8Bytes,
} from './bounds.js';
import type { ExtractionBounds, MutableOmission } from './bounds.js';
import type {
  EvidenceBundle,
  EvidenceItem,
  EvidenceKind,
  EvidenceProvenance,
  EvidenceStatus,
  PreparedSource,
  PreparedSpan,
} from './contracts.js';

interface Candidate extends Omit<EvidenceItem, 'id' | 'sourceId' | 'text'> {
  text: unknown;
}

interface ExtractionState {
  readonly items: EvidenceItem[];
  readonly omitted: MutableOmission;
  readonly calls: Map<string, { name: string; arguments: Record<string, unknown> }>;
  work: number;
  bytes: number;
}

export function extractEvidence(
  span: PreparedSpan,
  bounds: ExtractionBounds = DEFAULT_EXTRACTION_BOUNDS,
): EvidenceBundle {
  const state: ExtractionState = {
    items: [],
    omitted: { ...span.omitted, reasons: [...span.omitted.reasons] },
    calls: new Map(),
    work: 0,
    bytes: 0,
  };
  for (const source of span.sources) {
    if (state.work >= bounds.maxWorkUnits) {
      omit(state.omitted, 'work-limit');
      break;
    }
    state.work += 1;
    extractSource(source, state, bounds);
  }
  return { schemaVersion: 1, items: state.items, omitted: freezeOmission(state.omitted) };
}

function extractSource(source: PreparedSource, state: ExtractionState, bounds: ExtractionBounds): void {
  if (source.section === 'previous_summary') {
    add(state, source, {
      provenance: 'agent-reported', kind: 'report', status: 'observed', text: source.text,
    }, bounds);
    return;
  }
  const rawMessage: unknown = source.message;
  if (!isRecord(rawMessage) || typeof rawMessage.role !== 'string') {
    omit(state.omitted, 'unsupported-message');
    return;
  }
  const message = rawMessage;
  if (message.role === 'user') {
    for (const text of textContent(message.content)) {
      add(state, source, { provenance: 'requested', kind: 'request', status: 'requested', text }, bounds);
      for (const match of explicitFacts(text)) {
        add(state, source, {
          provenance: 'requested', kind: match.kind, status: 'requested', text: match.text,
          key: `${match.kind}:${match.text.toLowerCase()}`,
        }, bounds);
      }
    }
    return;
  }
  if (message.role === 'assistant') {
    for (const block of arrayValue(message.content)) {
      if (!isRecord(block)) continue;
      if (block.type === 'text') {
        add(state, source, {
          provenance: 'agent-reported', kind: 'report', status: 'observed', text: block.text,
        }, bounds);
      } else if (block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string') {
        const args = isRecord(block.arguments) ? block.arguments : {};
        state.calls.set(block.id, { name: block.name, arguments: args });
        add(state, source, {
          provenance: 'requested',
          kind: 'tool-call',
          status: 'requested',
          text: `${block.name} ${stableJson(args)}`,
          toolCallId: stableIdentifier(block.id, 'call'),
          toolName: stableIdentifier(block.name, 'tool'),
        }, bounds);
      }
    }
    return;
  }
  if (message.role === 'toolResult') extractToolResult(source, message, state, bounds);
  else omit(state.omitted, 'unsupported-message');
}

type ExplicitFact = {
  kind: Extract<EvidenceKind, 'constraint' | 'decision' | 'open-loop'>;
  text: string;
};

function explicitFacts(text: string): ExplicitFact[] {
  const facts: ExplicitFact[] = [];
  for (const sentence of text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)) {
    if (/\b(?:must|need to|required?|always|never|do not|don't|prefer|constraint)\b/iu.test(sentence)) {
      facts.push({ kind: 'constraint', text: sentence });
    } else if (/\b(?:decided|decision|we will|choose|chosen|agreed|keep|avoid)\b/iu.test(sentence)) {
      facts.push({ kind: 'decision', text: sentence });
    } else if (/\b(?:todo|to-do|still need|remaining|follow[- ]?up|next step|blocked|waiting for)\b/iu.test(sentence)) {
      facts.push({ kind: 'open-loop', text: sentence });
    }
  }
  return facts;
}

function extractToolResult(
  source: PreparedSource,
  message: Record<string, unknown>,
  state: ExtractionState,
  bounds: ExtractionBounds,
): void {
  const rawCallId = typeof message.toolCallId === 'string' ? message.toolCallId : '';
  const call = state.calls.get(rawCallId);
  const toolName = typeof message.toolName === 'string' ? message.toolName : call?.name ?? 'unknown';
  const toolCallId = stableIdentifier(rawCallId, 'call');
  const isError = message.isError === true;
  const common = { toolCallId, toolName: stableIdentifier(toolName, 'tool') };
  const details = isRecord(message.details) ? message.details : undefined;
  let handled = false;

  if (toolName === 'apply_patch' && details) {
    handled = extractPatch(source, details, common, state, bounds);
  } else if (toolName === 'read' || toolName === 'write' || toolName === 'edit') {
    const path = cleanPath(call?.arguments.path, bounds);
    const action = toolName === 'read' ? 'Read' : toolName === 'write' ? 'Wrote' : 'Edited';
    add(state, source, {
      provenance: 'recorded-result', kind: 'file', status: isError ? 'failed' : 'succeeded',
      text: path ? `${action} ${path}` : `${action} file (path unavailable)`,
      ...common, ...(path ? { key: `file:${path}`, paths: [path] } : {}),
    }, bounds);
    handled = true;
  } else if (isTaskTool(toolName) && details) {
    handled = extractTasks(source, details, common, state, bounds);
  } else if (isBackgroundTool(toolName) && details) {
    handled = extractBackground(source, details, common, state, bounds);
  } else if (toolName === 'bash' || toolName === 'exec_command' || toolName === 'write_stdin') {
    const command = stringValue(call?.arguments.command) ?? stringValue(call?.arguments.cmd) ?? toolName;
    const text = textContent(message.content).join('\n');
    const test = looksLikeTestCommand(command);
    add(state, source, {
      provenance: 'recorded-result', kind: test ? 'test' : 'command', status: isError ? 'failed' : 'succeeded',
      text: `${isError ? 'Failed' : 'Completed'}: ${command}${text ? `\n${text}` : ''}`,
      ...common, key: `${test ? 'test' : 'command'}:${command}`,
    }, bounds);
    handled = true;
  }

  if (isError && !handled) {
    add(state, source, {
      provenance: 'recorded-result', kind: 'error', status: 'failed',
      text: textContent(message.content).join('\n') || `${toolName} failed`, ...common,
      key: `failure:${toolCallId}`,
    }, bounds);
  } else if (!handled) {
    const text = textContent(message.content).join('\n');
    if (text) add(state, source, {
      provenance: 'observed', kind: 'observation', status: 'observed', text, ...common,
    }, bounds);
  }
  extractRtk(source, details, common, state, bounds);
}

function extractPatch(
  source: PreparedSource,
  details: Record<string, unknown>,
  common: Pick<EvidenceItem, 'toolCallId' | 'toolName'>,
  state: ExtractionState,
  bounds: ExtractionBounds,
): boolean {
  if (details.status !== 'success' && details.status !== 'partial_failure') return false;
  if (!isRecord(details.result)) return false;
  const paths = boundedPaths(details.result.changedFiles, bounds, state.omitted);
  const failedPath = cleanPath(details.failedPath, bounds);
  const partial = details.status === 'partial_failure';
  add(state, source, {
    provenance: 'recorded-result', kind: 'file', status: partial ? 'partial' : 'succeeded',
    text: partial
      ? `Patch partially applied${failedPath ? `; failed at ${failedPath}` : ''}${paths.length ? `; changed ${paths.join(', ')}` : ''}`
      : `Patch applied${paths.length ? `; changed ${paths.join(', ')}` : ''}`,
    ...common, key: `patch:${common.toolCallId ?? source.sourceId}`, paths,
  }, bounds);
  return true;
}

function extractTasks(
  source: PreparedSource,
  details: Record<string, unknown>,
  common: Pick<EvidenceItem, 'toolCallId' | 'toolName'>,
  state: ExtractionState,
  bounds: ExtractionBounds,
): boolean {
  const tasks = isRecord(details.task) ? [details.task] : arrayValue(details.tasks).filter(isRecord);
  let handled = false;
  for (const task of tasks.slice(0, bounds.maxPathsPerItem)) {
    const id = typeof task.id === 'string' ? stableIdentifier(task.id, 'task') : undefined;
    const status = taskStatus(task.status);
    if (!id || !status) continue;
    const title = sanitizeText(task.title, Math.floor(bounds.maxTextBytes / 2)).text || '(untitled)';
    add(state, source, {
      provenance: 'recorded-result', kind: 'task', status, text: `${id} ${status}: ${title}`,
      ...common, key: `task:${id}`,
    }, bounds);
    handled = true;
  }
  if (tasks.length > bounds.maxPathsPerItem) omit(state.omitted, 'task-limit', tasks.length - bounds.maxPathsPerItem);
  return handled;
}

function extractBackground(
  source: PreparedSource,
  details: Record<string, unknown>,
  common: Pick<EvidenceItem, 'toolCallId' | 'toolName'>,
  state: ExtractionState,
  bounds: ExtractionBounds,
): boolean {
  const records = [details, details.job, ...arrayValue(details.jobs)].filter(isRecord);
  let handled = false;
  for (const record of records.slice(0, bounds.maxPathsPerItem)) {
    const nestedStatus = isRecord(record.status) ? record.status.status : record.status;
    const nestedMeta = isRecord(record.meta) ? record.meta : record;
    const idValue = record.id ?? nestedMeta.id;
    const id = typeof idValue === 'string' ? stableIdentifier(idValue, 'job') : undefined;
    const status = backgroundStatus(nestedStatus);
    if (!id || !status) continue;
    const exit = isRecord(record.status) && typeof record.status.exitCode === 'number'
      ? ` (exit ${record.status.exitCode})`
      : '';
    add(state, source, {
      provenance: 'recorded-result', kind: 'background-job', status,
      text: `Background job ${id}: ${status}${exit}`, ...common, key: `background:${id}`,
    }, bounds);
    handled = true;
  }
  return handled;
}

function extractRtk(
  source: PreparedSource,
  details: Record<string, unknown> | undefined,
  common: Pick<EvidenceItem, 'toolCallId' | 'toolName'>,
  state: ExtractionState,
  bounds: ExtractionBounds,
): void {
  const metadata = details && (isRecord(details.rtkCompaction)
    ? details.rtkCompaction
    : isRecord(details.metadata) && isRecord(details.metadata.rtkCompaction)
      ? details.metadata.rtkCompaction
      : undefined);
  if (!metadata || metadata.applied !== true) return;
  const techniques = arrayValue(metadata.techniques)
    .filter((value): value is string => typeof value === 'string')
    .slice(0, 16)
    .map((value) => sanitizeText(value, 64).text)
    .filter(Boolean);
  const recoveryPath = metadata.truncated === true ? cleanPath(metadata.recoveryPath, bounds) : undefined;
  add(state, source, {
    provenance: 'recorded-result', kind: 'rtk-pointer', status: 'observed',
    text: `RTK compacted output${techniques.length ? ` using ${techniques.join(', ')}` : ''}${recoveryPath ? `; recovery ${recoveryPath}` : ''}`,
    ...common, ...(recoveryPath ? { recoveryPath } : {}), techniques,
  }, bounds);
}

function add(
  state: ExtractionState,
  source: PreparedSource,
  candidate: Candidate,
  bounds: ExtractionBounds,
): void {
  if (state.items.length >= bounds.maxEvidenceItems) {
    omit(state.omitted, 'evidence-item-limit');
    return;
  }
  const sanitized = sanitizeText(candidate.text, bounds.maxTextBytes);
  if (!sanitized.text) return;
  if (sanitized.omittedBytes > 0) omit(state.omitted, 'text-byte-limit', 0, sanitized.omittedBytes);
  const ordinal = state.items.length;
  const item: EvidenceItem = {
    ...candidate,
    id: `evidence:${source.sourceId}:${ordinal}`,
    sourceId: source.sourceId,
    text: sanitized.text,
  };
  const bytes = utf8Bytes(JSON.stringify(item));
  if (state.bytes + bytes > bounds.maxEvidenceBytes) {
    omit(state.omitted, 'evidence-byte-limit', 1, bytes);
    return;
  }
  state.items.push(item);
  state.bytes += bytes;
}

function boundedPaths(value: unknown, bounds: ExtractionBounds, omitted: MutableOmission): string[] {
  const raw = arrayValue(value);
  const paths = raw.slice(0, bounds.maxPathsPerItem)
    .map((path) => cleanPath(path, bounds))
    .filter((path): path is string => Boolean(path));
  if (raw.length > paths.length) omit(omitted, 'path-limit-or-invalid', raw.length - paths.length);
  return [...new Set(paths)];
}

function cleanPath(value: unknown, bounds: ExtractionBounds): string | undefined {
  const text = sanitizeText(value, Math.min(bounds.maxTextBytes, 512)).text;
  return text || undefined;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(sortJson(value), null, 0) ?? '{}';
  } catch {
    return '{}';
  }
}

function sortJson(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth omitted]';
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => sortJson(item, depth + 1));
  if (!isRecord(value)) return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null
    ? value
    : String(value);
  return Object.fromEntries(Object.keys(value).sort().slice(0, 32).map((key) => [key, sortJson(value[key], depth + 1)]));
}

function textContent(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return arrayValue(value).filter(isRecord)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string);
}

function taskStatus(value: unknown): EvidenceStatus | undefined {
  if (value === 'completed') return 'completed';
  if (value === 'cancelled') return 'cancelled';
  if (value === 'blocked') return 'blocked';
  if (value === 'in_progress' || value === 'pending') return value === 'in_progress' ? 'running' : 'requested';
  return undefined;
}

function backgroundStatus(value: unknown): EvidenceStatus | undefined {
  if (value === 'running') return 'running';
  if (value === 'completed') return 'completed';
  if (value === 'failed' || value === 'unknown') return 'failed';
  if (value === 'killed') return 'cancelled';
  return undefined;
}

function isTaskTool(value: string): boolean {
  return value === 'TaskCreate' || value === 'TaskUpdate' || value === 'TaskList' || value === 'TaskGet';
}

function isBackgroundTool(value: string): boolean {
  return value.endsWith('_background_bash') || value === 'list_background_bash';
}

function looksLikeTestCommand(command: string): boolean {
  return /(?:^|\s)(?:test|vitest|jest|pytest|cargo test|go test|pnpm test|npm test)(?:\s|$)/iu.test(command);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
