import type { BackgroundBashJob } from './job-store.js';

export const PROCESS_VIEW_PAGE_SIZE = 18;
export const PROCESS_VIEW_BYTES = 60 * 1024;
export const PROCESS_LOG_BYTES = 128 * 1024;
const LOG_CHUNK_BYTES = 24 * 1024;
const encoder = new TextEncoder();

export interface ProcessViewJob {
  id: string; command: string; commandTruncated: boolean;
  status: 'running' | 'completed' | 'failed' | 'killed' | 'unknown';
  startedAt: number; updatedAt: number; completedAt?: number;
}
export interface ProcessViewRequest {
  viewId: string; sequence: number; offset: number; total: number; running: number;
  jobs: ProcessViewJob[]; selectedId?: string; notice?: string;
  detail?: { id: string; index: number; chunks: number; text: string };
}
type ActionData = { action: 'close' | 'list' | 'refresh' }
  | { action: 'page'; offset: number; select: 'first' | 'last' }
  | { action: 'detail'; id: string }
  | { action: 'output'; index: number }
  | { action: 'signal'; id: string; signal: 'SIGTERM' | 'SIGKILL' };
export type ProcessViewAction = ActionData & { viewId: string; sequence: number };

function invalid(): never { throw new Error('Invalid process view data.'); }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) invalid();
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}
function id(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value); }
function text(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && encoder.encode(value).length <= bytes
    && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

export function clipProcessText(value: string, maximum: number): string {
  let result = ''; let size = 2;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    const safe = code >= 0xd800 && code <= 0xdfff ? '\uFFFD' : char;
    const length = encodedCharacterBytes(safe);
    if (size + length > maximum) break;
    result += safe; size += length;
  }
  return result;
}

function encodedCharacterBytes(char: string): number {
  const code = char.codePointAt(0)!;
  return code === 34 || code === 92 ? 2 : code < 32
    ? [8, 9, 10, 12, 13].includes(code) ? 2 : 6
    : code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
}

export function processViewJob(job: BackgroundBashJob): ProcessViewJob {
  const command = clipProcessText(job.meta.command, 512);
  return { id: job.meta.id, command, commandTruncated: command !== job.meta.command,
    status: job.status.status, startedAt: job.meta.startedAt, updatedAt: job.status.updatedAt,
    ...(job.status.completedAt === undefined ? {} : { completedAt: job.status.completedAt }) };
}

export function splitProcessLog(value: string): string[] {
  const bytes = encoder.encode(value.slice(-PROCESS_LOG_BYTES));
  let start = Math.max(0, bytes.length - PROCESS_LOG_BYTES);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  const normalized = new TextDecoder().decode(bytes.subarray(start));
  const chunks: string[] = []; let chunk = ''; let size = 2;
  for (const char of normalized) {
    const length = encodedCharacterBytes(char);
    if (size + length > LOG_CHUNK_BYTES) { chunks.push(chunk); chunk = ''; size = 2; }
    chunk += char; size += length;
  }
  chunks.push(chunk);
  return chunks;
}

export function parseProcessViewRequest(value: unknown): ProcessViewRequest {
  if (!record(value)) invalid();
  exact(value, ['viewId', 'sequence', 'offset', 'total', 'running', 'jobs', 'selectedId', 'notice', 'detail']);
  if (!id(value.viewId) || !integer(value.sequence) || !value.sequence || !integer(value.offset)
    || value.offset % PROCESS_VIEW_PAGE_SIZE || !integer(value.total) || !integer(value.running, value.total)
    || (value.total === 0 ? value.offset !== 0 : value.offset >= value.total)
    || !Array.isArray(value.jobs) || value.jobs.length !== Math.min(PROCESS_VIEW_PAGE_SIZE, value.total - value.offset)) invalid();
  const jobs = value.jobs.map((job): ProcessViewJob => {
    if (!record(job)) invalid();
    exact(job, ['id', 'command', 'commandTruncated', 'status', 'startedAt', 'updatedAt', 'completedAt']);
    if (!id(job.id) || !text(job.command, 512) || typeof job.commandTruncated !== 'boolean'
      || !['running', 'completed', 'failed', 'killed', 'unknown'].includes(job.status as string)
      || !integer(job.startedAt) || !integer(job.updatedAt)
      || job.completedAt !== undefined && !integer(job.completedAt)) invalid();
    return { ...job } as unknown as ProcessViewJob;
  });
  if (new Set(jobs.map(job => job.id)).size !== jobs.length || jobs.filter(job => job.status === 'running').length > value.running
    || value.selectedId !== undefined && !jobs.some(job => job.id === value.selectedId)
    || value.notice !== undefined && !text(value.notice, 512)) invalid();
  if (value.detail !== undefined) {
    const detail = value.detail;
    if (!record(detail)) invalid();
    exact(detail, ['id', 'index', 'chunks', 'text']);
    if (detail.id !== value.selectedId || !id(detail.id) || !integer(detail.chunks, 64) || !detail.chunks
      || !integer(detail.index, detail.chunks - 1) || !text(detail.text, LOG_CHUNK_BYTES)
      || encoder.encode(JSON.stringify(detail.text)).length > LOG_CHUNK_BYTES) invalid();
  }
  if (encoder.encode(JSON.stringify(value)).length > PROCESS_VIEW_BYTES) invalid();
  return { ...value, jobs, ...(value.detail === undefined ? {} : { detail: { ...value.detail as object } }) } as ProcessViewRequest;
}

export function processViewAction(request: ProcessViewRequest, action: ActionData): ProcessViewAction {
  return parseProcessViewAction({ viewId: request.viewId, sequence: request.sequence, ...action }, request);
}

export function parseProcessViewAction(value: unknown, request: ProcessViewRequest): ProcessViewAction {
  if (!record(value) || value.viewId !== request.viewId || value.sequence !== request.sequence) invalid();
  const base = ['viewId', 'sequence', 'action'];
  switch (value.action) {
    case 'close': case 'list': case 'refresh': exact(value, base); break;
    case 'page':
      exact(value, [...base, 'offset', 'select']);
      if (!integer(value.offset) || value.offset % PROCESS_VIEW_PAGE_SIZE || value.offset >= request.total
        || value.select !== 'first' && value.select !== 'last') invalid();
      break;
    case 'detail': case 'signal':
      exact(value, [...base, 'id', ...(value.action === 'signal' ? ['signal'] : [])]);
      if (!request.jobs.some(job => job.id === value.id)) invalid();
      if (value.action === 'signal' && value.signal !== 'SIGTERM' && value.signal !== 'SIGKILL') invalid();
      break;
    case 'output':
      exact(value, [...base, 'index']);
      if (!request.detail || !integer(value.index, request.detail.chunks - 1)) invalid();
      break;
    default: invalid();
  }
  return { ...value } as ProcessViewAction;
}

export const PROCESSES_HINT = Object.freeze({ id: 'felan.processes', version: '1' });
export type { BackgroundBashJob, BackgroundBashStatus, BackgroundBashQuery, BackgroundBashPage } from './job-store.js';
export { BACKGROUND_BASH_COMPLETION_MESSAGE_TYPE, type BackgroundProcessViewSource } from './presentation.js';
