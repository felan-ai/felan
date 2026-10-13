import { createHash, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { FELAN_THINKING_LEVELS, SESSION_EXECUTION_LIMITS, SessionsServiceError, type SessionExecution, type SessionsService, type SessionRef, type SessionExecutionsOptions } from '@felan-ai/agent-core';
import type { ExecutionHost, ExecutionRecord } from './executions.js';

export type SessionExecutionOperations = Pick<SessionsService, 'create' | 'executions' | 'execution' | 'steer' | 'cancel' | 'subscribe'>;

export function createSessionExecutions(host: ExecutionHost, current: SessionRef): SessionExecutionOperations {
  const key = randomBytes(32);
  const check = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('Session request aborted.', 'AbortError'); };
  const convert = (row: Pick<ExecutionRecord, 'executionId' | 'sessionId' | 'status' | 'result' | 'error' | 'parentSessionId' | 'label' | 'description' | 'createdAt' | 'startedAt' | 'completedAt' | 'model' | 'usage' | 'completionPending'>): SessionExecution => ({
    id: row.executionId, parent: row.parentSessionId, label: row.label, description: row.description, createdAt: row.createdAt,
    ...(row.completionPending === undefined ? {} : { completionPending: row.completionPending }),
    ...(row.startedAt ? { startedAt: row.startedAt } : {}), ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.model ? { model: row.model } : {}), ...(row.usage ? { usage: row.usage } : {}), ...(row.sessionId ? { session: { id: row.sessionId, root: current.root, parent: row.parentSessionId } } : {}),
    state: row.status === 'timed_out' ? 'failed' : row.status,
    ...(row.result !== undefined || row.error ? { result: { text: boundedText(row.result ?? '', SESSION_EXECUTION_LIMITS.resultTextBytes),
      truncated: Buffer.byteLength(row.result ?? '') > SESSION_EXECUTION_LIMITS.resultTextBytes,
      ...(row.error ? { error: boundedText(`${row.error.code}: ${row.error.message}`, SESSION_EXECUTION_LIMITS.resultErrorBytes) } : {}) } } : {}),
  });
  const find = (id: string) => {
    const row = host.getExecution(id);
    if (!row) throw new SessionsServiceError('inaccessible');
    return row;
  };
  const requireSuccess = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!result.ok) {
      const code = result.error && typeof result.error === 'object' && 'code' in result.error ? result.error.code : undefined;
      const message = result.error && typeof result.error === 'object' && 'message' in result.error && typeof result.error.message === 'string'
        ? boundedText(`${String(code)}: ${result.error.message}`, SESSION_EXECUTION_LIMITS.resultErrorBytes) : undefined;
      throw new SessionsServiceError(code === 'not_steerable' ? 'stale'
        : ['not_found', 'not_child', 'parent_unavailable', 'host_unavailable'].includes(String(code)) ? 'inaccessible' : 'invalid', message);
    }
    return result.value;
  };
  const cursor = (value: string) => `${Buffer.from(value).toString('base64url')}.${createHmac('sha256', key).update(value).digest('base64url')}`;
  return {
    async create(input, options) {
      check(options?.signal);
      if (!dataObject(input, ['prompt', 'description', 'appendSystemPrompt', 'model', 'thinking', 'maxTurns', 'timeoutMs', 'label', 'allowChildren', 'excludedTools', 'notifyOnCompletion'])
        || typeof input.prompt !== 'string' || typeof input.description !== 'string'
        || !input.prompt.trim() || Buffer.byteLength(input.prompt) > SESSION_EXECUTION_LIMITS.promptBytes
        || !input.description.trim() || Buffer.byteLength(input.description) > SESSION_EXECUTION_LIMITS.descriptionBytes
        || input.appendSystemPrompt !== undefined && (typeof input.appendSystemPrompt !== 'string' || Buffer.byteLength(input.appendSystemPrompt) > SESSION_EXECUTION_LIMITS.appendSystemPromptBytes)
        || input.model !== undefined && (!dataObject(input.model, ['provider', 'id']) || !identifier(input.model.provider) || !identifier(input.model.id))
        || input.thinking !== undefined && !FELAN_THINKING_LEVELS.includes(input.thinking)
        || input.label !== undefined && (typeof input.label !== 'string' || !input.label.trim() || Buffer.byteLength(input.label) > 256)
        || input.allowChildren !== undefined && typeof input.allowChildren !== 'boolean'
        || input.notifyOnCompletion !== undefined && typeof input.notifyOnCompletion !== 'boolean'
        || input.excludedTools !== undefined && (!Array.isArray(input.excludedTools) || input.excludedTools.length > 256 || input.excludedTools.some(name => !identifier(name)))
        || input.maxTurns !== undefined && (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > SESSION_EXECUTION_LIMITS.maxTurns)
        || input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > SESSION_EXECUTION_LIMITS.timeoutMs)) throw new SessionsServiceError('invalid');
      const row = requireSuccess(await host.spawnSession(input, options?.signal));
      return convert(row);
    },
    async executions(options?: SessionExecutionsOptions) {
      check(options?.signal);
      const limit = options?.limit ?? 256;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new SessionsServiceError('invalid');
      const rows = host.listExecutions(options?.includeDescendants).map(convert);
      const revision = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
      let offset = 0;
      if (options?.cursor) {
        try {
          const [encoded, signature, extra] = options.cursor.split('.');
          if (!encoded || !signature || extra || options.cursor.length > 1024) throw new Error();
          const value = Buffer.from(encoded, 'base64url').toString();
          const expected = createHmac('sha256', key).update(value).digest();
          const actual = Buffer.from(signature, 'base64url');
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
          const parsed = JSON.parse(value) as { revision: string; offset: number };
          if (parsed.revision !== revision) throw new SessionsServiceError('stale');
          if (!Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > rows.length) throw new Error();
          offset = parsed.offset;
        } catch (error) { throw new SessionsServiceError(error instanceof SessionsServiceError ? error.code : 'invalid'); }
      }
      const items: SessionExecution[] = [];
      let bytes = 1024;
      for (const row of rows.slice(offset, offset + limit)) {
        const size = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (bytes + size > 12 * 1024 * 1024) break;
        items.push(row); bytes += size;
      }
      if (!items.length && offset < rows.length) throw new SessionsServiceError('oversize');
      return { items, ...(offset + items.length < rows.length ? { nextCursor: cursor(JSON.stringify({ revision, offset: offset + items.length })) } : {}) };
    },
    async execution(id, options) { check(options?.signal); const result = requireSuccess(await host.getResult(id, options?.acknowledge === undefined ? undefined : { acknowledge: options.acknowledge })); return convert({ ...find(id), ...result }); },
    async steer(id, message, options) {
      check(options?.signal);
      if (typeof message !== 'string' || !message.trim() || Buffer.byteLength(message) > SESSION_EXECUTION_LIMITS.steerBytes) throw new SessionsServiceError('invalid');
      find(id); requireSuccess(await host.steer(id, message));
    },
    async cancel(id, reason, options) {
      check(options?.signal);
      if (reason !== undefined && (typeof reason !== 'string' || Buffer.byteLength(reason) > SESSION_EXECUTION_LIMITS.cancelReasonBytes)) throw new SessionsServiceError('invalid');
      const row = find(id);
      if (['completed', 'failed', 'timed_out', 'cancelled'].includes(row.status)) return;
      requireSuccess(await host.cancel(id, reason));
    },
    subscribe(listener) {
      const revisions = new Map<string, string>();
      const update = () => {
        for (const row of host.listExecutions(true)) {
          const revision = JSON.stringify(convert(row));
          if (revisions.get(row.executionId) === revision) continue;
          revisions.set(row.executionId, revision); listener({ kind: 'execution', id: row.executionId });
        }
      };
      const unsubscribe = host.subscribe(update);
      return unsubscribe;
    },
  };
}

function boundedText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function dataObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(Object.getOwnPropertyDescriptors(value)).every(([key, property]) => keys.includes(key) && 'value' in property);
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}
