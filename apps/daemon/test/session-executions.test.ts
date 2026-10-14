import { describe, expect, it, vi } from 'vitest';
import type { ExecutionHost, ExecutionRecord } from '../src/daemon/executions.js';
import { createSessionExecutions } from '../src/daemon/session-executions.js';

function fixture() {
  const record: ExecutionRecord = { executionId: 'execution', parentSessionId: 'root', rootSessionId: 'root',
    label: 'session', description: 'task', status: 'queued', createdAt: '2026-08-24T00:00:00Z' };
  const host = { spawnSession: vi.fn(async () => ({ ok: true as const, value: record })),
    listExecutions: vi.fn(() => [record]), getExecution: vi.fn((id: string) => id === record.executionId ? record : undefined),
    getResult: vi.fn(async () => ({ ok: true as const, value: record })),
    steer: vi.fn(async () => ({ ok: true as const, value: record })), cancel: vi.fn(async () => ({ ok: true as const, value: record })),
    subscribe: vi.fn(() => () => {}) };
  return { record, host, service: createSessionExecutions(host as unknown as ExecutionHost, { id: 'root', root: 'root' }) };
}

describe('Sessions execution adapter', () => {
  it('delegates creation to the existing admitted scheduler without resolving a named agent definition', async () => {
    const f = fixture();
    const input = { prompt: 'work', description: 'task', appendSystemPrompt: 'instructions', model: { provider: 'provider', id: 'model' }, maxTurns: 3 };
    expect(await f.service.create(input)).toMatchObject({ id: 'execution', state: 'queued' });
    expect(f.host.spawnSession).toHaveBeenCalledWith(input, undefined);
    Object.assign(f.record, { sessionId: 'registered-session', status: 'running' });
    expect(await f.service.execution('execution')).toMatchObject({ id: 'execution', session: { id: 'registered-session', root: 'root', parent: 'root' }, state: 'running' });
  });

  it('keeps reads non-consuming and cancellation idempotent for terminal records', async () => {
    const f = fixture();
    expect(await f.service.execution('execution')).toEqual(await f.service.execution('execution'));
    expect(f.host.getResult).toHaveBeenNthCalledWith(1, 'execution', undefined);
    expect(f.host.getResult).toHaveBeenNthCalledWith(2, 'execution', undefined);
    Object.assign(f.record, { status: 'completed', result: 'done', sessionId: 'execution' });
    await f.service.cancel('execution');
    expect(f.host.cancel).not.toHaveBeenCalled();
    expect(await f.service.execution('execution')).toMatchObject({ state: 'completed', result: { text: 'done', truncated: false } });
    await expect(f.service.steer('foreign', 'next')).rejects.toMatchObject({ code: 'inaccessible' });
  });

  it('rejects cancelled work before scheduler admission', async () => {
    const f = fixture();
    await expect(f.service.create({ prompt: 'work', description: 'task' }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.host.spawnSession).not.toHaveBeenCalled();
  });
});
