import { describe, expect, it, vi } from 'vitest';
import { SESSION_EXECUTION_LIMITS } from '@felan-ai/agent-core';
import { createSessionExecutions } from '../src/daemon/session-executions.js';
import type { ExecutionHost } from '../src/daemon/executions.js';

function fixture(status: 'queued' | 'completed' = 'queued', result?: string) {
  const row = { executionId: 'execution', rootSessionId: 'root', parentSessionId: 'root', label: 'session',
    description: 'Fixture', createdAt: '2026-01-01T00:00:00Z', status, ...(result === undefined ? {} : { result }) };
  const spawnSession = vi.fn(async () => ({ ok: true as const, value: row }));
  const host = { spawnSession, listExecutions: () => [{ ...row, ...(status === 'completed' ? { sessionId: 'actual-session' } : {}) }],
    getExecution: () => ({ ...row, ...(status === 'completed' ? { sessionId: 'actual-session' } : {}) }),
    getResult: vi.fn(async () => ({ ok: true as const, value: row })),
    steer: vi.fn(async () => ({ ok: true as const, value: row })), cancel: vi.fn(async () => ({ ok: true as const, value: row })),
    subscribe: vi.fn(() => () => {}), subscribeUsage: vi.fn((_listener: () => void) => () => {}) };
  return { host, spawnSession, operations: createSessionExecutions(host as unknown as ExecutionHost, { id: 'root', root: 'root' }) };
}

describe('scoped session execution operations', () => {
  it('returns the queued execution identity without inventing a session identity', async () => {
    const { operations } = fixture();
    const result = await operations.create({ prompt: 'Task', description: 'Fixture' });
    expect(result).toMatchObject({ id: 'execution', state: 'queued', label: 'session', description: 'Fixture', parent: 'root' });
    expect(result.session).toBeUndefined();
  });

  it('reports a canonical session only after admission and bounds UTF-8 result bytes', async () => {
    const text = '🙂'.repeat(SESSION_EXECUTION_LIMITS.resultTextBytes);
    const { operations } = fixture('completed', text);
    const result = await operations.execution('execution');
    expect(result.session).toEqual({ id: 'actual-session', root: 'root', parent: 'root' });
    expect(result.result?.truncated).toBe(true);
    expect(Buffer.byteLength(result.result!.text)).toBeLessThanOrEqual(SESSION_EXECUTION_LIMITS.resultTextBytes);
    expect(result.result!.text).not.toContain('�');
  });

  it.each([
    { prompt: '' }, { maxTurns: 0 }, { maxTurns: 101 }, { maxTurns: 1.5 }, { timeoutMs: 0 },
    { timeoutMs: 86_400_001 }, { model: null }, { model: { provider: '', id: 'model' } },
    { thinking: 'invented' }, { appendSystemPrompt: 'a'.repeat(SESSION_EXECUTION_LIMITS.appendSystemPromptBytes + 1) },
    { runtime: {} },
  ])('rejects invalid admission input without spawning: %j', async invalid => {
    const { operations, spawnSession } = fixture();
    await expect(operations.create({ prompt: 'Task', description: 'Fixture', ...invalid } as never)).rejects.toMatchObject({ code: 'invalid' });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('bounds steering and cancellation input, and cancellation of a finished execution is idempotent', async () => {
    const { operations, host } = fixture('completed');
    await expect(operations.steer('execution', 'a'.repeat(SESSION_EXECUTION_LIMITS.steerBytes + 1))).rejects.toMatchObject({ code: 'invalid' });
    await expect(operations.cancel('execution', 'a'.repeat(SESSION_EXECUTION_LIMITS.cancelReasonBytes + 1))).rejects.toMatchObject({ code: 'invalid' });
    await operations.cancel('execution', 'Already complete');
    expect(host.steer).not.toHaveBeenCalled();
    expect(host.cancel).not.toHaveBeenCalled();
  });

  it.each(['unsupported_model', 'unsupported_thinking', 'depth_exceeded'])('preserves %s admission diagnostics', async code => {
    const { host, operations } = fixture();
    host.spawnSession.mockResolvedValueOnce({ ok: false, error: { code, message: 'Specific admission reason' } } as never);
    await expect(operations.create({ prompt: 'Task', description: 'Fixture' })).rejects.toMatchObject({ message: `${code}: Specific admission reason` });
  });

  it('includes bounded UTF-8 failure reasons in execution results', async () => {
    const { host, operations } = fixture('completed');
    host.getResult.mockResolvedValueOnce({ ok: true, value: { ...host.getExecution(), error: { code: 'model_request_failed', message: `Connection refused ${'🙂'.repeat(4096)}` } } } as never);
    const result = await operations.execution('execution');
    expect(result.result?.error).toContain('model_request_failed: Connection refused');
    expect(Buffer.byteLength(result.result!.error!)).toBeLessThanOrEqual(SESSION_EXECUTION_LIMITS.resultErrorBytes);
    expect(result.result?.error).not.toContain('�');
  });

  it('publishes registry execution changes and releases its subscription', () => {
    const { host, operations } = fixture();
    const release = vi.fn(); let refresh!: () => void;
    host.subscribe.mockImplementation(((listener: () => void) => { refresh = listener; return release; }) as never);
    const listener = vi.fn(); const stop = operations.subscribe(listener);
    refresh(); refresh();
    expect(listener).toHaveBeenCalledOnce();
    stop(); expect(release).toHaveBeenCalledOnce();
  });
});
