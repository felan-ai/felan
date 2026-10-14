import { expect, it, vi } from 'vitest';
import { SESSIONS_SERVICE, type SessionExecution, type SessionsService } from '@felan-ai/agent-core';
import subagents from '../../../packages/ext-subagents/src/extension.js';
import { extensionFixture } from './generic-extension-ui-fixtures.js';

it('executes the default subagent tools through Sessions without UI and keeps result reads non-consuming', async () => {
  const h = extensionFixture();
  const queued: SessionExecution = { id: 'child', parent: 'session', label: 'general',
    description: 'Inspect changes', state: 'queued', createdAt: new Date(0).toISOString() };
  const completed: SessionExecution = { ...queued, state: 'completed', result: { text: 'Verified child result.', truncated: false } };
  const sessions = {
    current: { id: 'session', root: 'session' },
    list: vi.fn(async () => ({ items: [] })),
    create: vi.fn(async () => queued),
    executions: vi.fn(async () => ({ items: [queued] })),
    execution: vi.fn(async () => completed),
    steer: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
  } as unknown as SessionsService;
  Object.assign(h.api.runtime, { listFiles: vi.fn(async () => []) });
  h.services.set(SESSIONS_SERVICE, sessions);
  await h.install(subagents);
  await h.emit('session_start');
  expect(h.context.hasUI).toBe(false);
  expect([...h.tools.keys()]).toEqual(['Agent', 'list_subagents', 'get_subagent_result', 'steer_subagent', 'cancel_subagent']);
  const spawned = await h.tool('Agent', { subagent_type: 'general', description: 'Inspect changes', prompt: 'Review the patch.' });
  expect(sessions.create).toHaveBeenCalledWith(expect.objectContaining({ label: 'general', description: 'Inspect changes', prompt: 'Review the patch.', notifyOnCompletion: true }), expect.anything());
  expect(JSON.stringify(spawned)).toContain('queued');
  await h.tool('list_subagents', {});
  expect(sessions.executions).toHaveBeenCalledOnce();
  for (let index = 0; index < 2; index++) expect(JSON.stringify(await h.tool('get_subagent_result', { agent_id: 'child' }))).toContain('Verified child result.');
  expect(sessions.execution).toHaveBeenCalledTimes(2);
  for (const [id, options] of vi.mocked(sessions.execution).mock.calls) {
    expect(id).toBe('child');
    expect(options?.acknowledge).not.toBe(true);
  }
  await h.tool('get_subagent_result', { agent_id: 'child', acknowledge_completion: true });
  expect(sessions.execution).toHaveBeenLastCalledWith('child', { acknowledge: true });
  await h.tool('steer_subagent', { agent_id: 'child', message: 'Focus on cancellation.' });
  expect(sessions.steer).toHaveBeenCalledWith('child', 'Focus on cancellation.');
  await h.tool('cancel_subagent', { agent_id: 'child', reason: 'No longer needed' });
  expect(sessions.cancel).toHaveBeenCalledWith('child', 'No longer needed');
  expect(h.forms).toEqual([]); expect(h.elements).toEqual([]);
});
