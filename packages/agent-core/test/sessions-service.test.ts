import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createExtensionServiceAccess, createFelanServiceRegistry, type SessionEntry } from '../src/index.js';
import {
  SESSION_HISTORY_LIMITS,
  SESSIONS_SERVICE,
  SESSIONS_HISTORY_SERVICE,
  createReadOnlySessionsService,
  SessionsServiceError,
  type HistoryRevision,
  type SessionCheckpointRef,
  type SessionExecution,
  type SessionExecutionInput,
  type SessionHistoryPage,
  type SessionPageOptions,
  type SessionRef,
  type SessionsHistory,
  type SessionsRequestOptions,
  type SessionsService,
} from '../src/services/sessions.js';

describe('Sessions service contract', () => {
  it('uses portable full history values and opaque content revisions', () => {
    expectTypeOf<HistoryRevision>().toEqualTypeOf<{ readonly sessionId: string; readonly revision: string; readonly branch: string | null }>();
    expectTypeOf<SessionHistoryPage['entries']>().toEqualTypeOf<readonly SessionEntry[]>();
    expectTypeOf<SessionRef>().toEqualTypeOf<{ readonly id: string; readonly root: string; readonly parent?: string }>();
    expectTypeOf<SessionPageOptions>().toEqualTypeOf<{ readonly cursor?: string; readonly limit?: number; readonly signal?: AbortSignal }>();
    expectTypeOf<SessionsRequestOptions>().toEqualTypeOf<{ readonly signal?: AbortSignal }>();
    expectTypeOf<keyof SessionsHistory>().toEqualTypeOf<'current' | 'list' | 'history' | 'checkpoint'>();
    expectTypeOf<Extract<keyof SessionCheckpointRef, 'path' | 'sessionFile' | 'sessionDir'>>().toEqualTypeOf<never>();
    expectTypeOf<SessionCheckpointRef['byteLength']>().toEqualTypeOf<number>();
    expectTypeOf<Extract<keyof SessionExecutionInput, 'cwd' | 'runtime' | 'registry' | 'services'>>().toEqualTypeOf<never>();
    expectTypeOf<SessionExecution['state']>().toEqualTypeOf<'queued' | 'running' | 'completed' | 'failed' | 'cancelled'>();
    expect(SESSION_HISTORY_LIMITS).toEqual({ fileBytes: 64 * 1024 * 1024, pageBytes: 12 * 1024 * 1024, pageEntries: 256 });
    expect(Object.isFrozen(SESSION_HISTORY_LIMITS)).toBe(true);
  });

  it('does not grant execution authority to a history-only consumer', () => {
    const registry = createFelanServiceRegistry();
    const source = { current: { id: 'session', root: 'session' }, list: vi.fn(), history: vi.fn(), checkpoint: vi.fn(), create: vi.fn(), steer: vi.fn() };
    const history = createReadOnlySessionsService(source);
    registry.set(SESSIONS_HISTORY_SERVICE, history);
    const access = createExtensionServiceAccess(registry, { required: [SESSIONS_HISTORY_SERVICE] });
    expect(access.get(SESSIONS_HISTORY_SERVICE)).toBe(history);
    expect(history).not.toHaveProperty('create');
    expect(history).not.toHaveProperty('steer');
    expect(history).not.toHaveProperty('openWorker');
    expect(history).not.toHaveProperty('registerLifecycle');
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.isFrozen(history.current)).toBe(true);
    expect(() => access.get(SESSIONS_SERVICE)).toThrow();
  });

  it('requires an admitted provider and exposes no history-driven execution shortcut', () => {
    expect(SESSIONS_SERVICE).toMatchObject({ id: 'felan.sessions', major: 1, key: 'felan.sessions@1' });
    expect(Object.isFrozen(SESSIONS_SERVICE)).toBe(true);
    const registry = createFelanServiceRegistry();
    const access = createExtensionServiceAccess(registry, { required: [SESSIONS_SERVICE] });
    expect(() => access.get(SESSIONS_SERVICE)).toThrow('no configured provider');
    const service: SessionsService = {
      current: { id: 'session', root: 'root' },
      list: vi.fn(), history: vi.fn(), checkpoint: vi.fn(), setTitleIfMissing: vi.fn(),
      create: vi.fn(), executions: vi.fn(), execution: vi.fn(), steer: vi.fn(), cancel: vi.fn(), subscribe: vi.fn(),
    };
    registry.set(SESSIONS_SERVICE, service);
    expect(access.get(SESSIONS_SERVICE)).toBe(service);
    expect(service.create).not.toHaveBeenCalled();
    expect(service.setTitleIfMissing).not.toHaveBeenCalled();
    expectTypeOf<keyof SessionsService>().toEqualTypeOf<
      'current' | 'list' | 'history' | 'checkpoint' | 'setTitleIfMissing' | 'create' | 'executions' | 'execution' | 'steer' | 'cancel' | 'subscribe'
    >();
    registry.revoke();
    expect(() => access.get(SESSIONS_SERVICE)).toThrow('revoked');
  });

  it.each(['invalid', 'inaccessible', 'stale', 'oversize', 'unsupported'] as const)('uses constant, context-free %s errors', code => {
    const error = new SessionsServiceError(code);
    expect(error).toMatchObject({ name: 'SessionsServiceError', code });
    expect(error).not.toHaveProperty('cause');
    expect(Object.keys(error).sort()).toEqual(['code', 'name']);
  });

  it('preserves a provider-supplied safe diagnostic', () => {
    expect(new SessionsServiceError('invalid', 'Maximum execution depth reached')).toMatchObject({ code: 'invalid', message: 'Maximum execution depth reached' });
  });

  it('does not echo arbitrary error constructor input', () => {
    const privateText = 'private-history-path-and-content';
    const error = new SessionsServiceError(privateText as never);
    expect(error.code).toBe('invalid');
    expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain(privateText);
  });
});
