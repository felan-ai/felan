import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_DISPLAY_KEY, MESSAGE_DISPLAY_ID, parseSessionSnapshot, readMessageDisplay, type SessionEvent } from '@felan-ai/session-protocol';
import { ControlStoreError } from '../src/daemon/control-state.js';
import { projectPiMessage } from '../src/daemon/projection.js';
import type { SessionEntry } from '@felan-ai/agent-core';
import { assistant, deferred, fixture, fixtures, offlineModel, requestId, supported } from './fixtures/registry.js';

afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });

describe('tool result content projection', () => {
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1EAAAAASUVORK5CYII=' };
  const result = { role: 'toolResult' as const, toolCallId: 'call', toolName: 'generate_images', isError: false, timestamp: 0,
    content: [{ type: 'text' as const, text: 'first' }, image, { type: 'text' as const, text: 'second' }, image], details: { artifacts: ['fixture.png'] } };
  const entry: Extract<SessionEntry, { type: 'message' }> = {
    type: 'message', id: 'entry', parentId: null, timestamp: '2026-10-10T00:00:00.000Z',
    message: result,
  };
  it('retains generated images and browser screenshots alongside tool text and details', () => {
    expect(projectPiMessage(entry)).toMatchObject({ role: 'tool', content: [
      { type: 'tool_result', id: 'call', text: 'first\nsecond', isError: false, details: { artifacts: ['fixture.png'] } }, image, image,
    ] });
    expect(projectPiMessage(entry).details).toMatchObject({ artifacts: ['fixture.png'],
      [MESSAGE_DISPLAY_KEY]: { kind: 'tool', name: 'generate_images', timestamp: 0 } });
  });
  it('does not silently discard invalid image data', () => {
    const invalid = { ...entry, message: { ...result, content: [{ ...image, data: '@@@' }] } };
    expect(() => projectPiMessage(invalid)).toThrow();
  });
});

it('preserves real assistant metadata separately from text and leaves scalar tool details untouched', () => {
  const message = { ...assistant('Actual content'), timestamp: 42, model: 'actual-model',
    usage: { input: 17, output: 23, cacheRead: 2, cacheWrite: 3, totalTokens: 45,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 } } };
  const entry = { type: 'message' as const, id: 'entry', parentId: null, timestamp: new Date(100).toISOString(), message };
  expect(readMessageDisplay(projectPiMessage(entry).details)).toMatchObject({ timestamp: 42, model: 'actual-model', usage: message.usage });
  expect(projectPiMessage({ ...entry, message: { role: 'toolResult', toolCallId: 'call', toolName: 'read', content: [], isError: false,
    timestamp: 43, details: 'unchanged scalar' } }).details).toBe('unchanged scalar');
});

it('projects compaction summaries without interpreting feature-specific details', () => {
  const message = projectPiMessage({ type: 'compaction', id: 'compact', parentId: null, timestamp: new Date(0).toISOString(),
    summary: 'Retained summary', firstKeptEntryId: 'first', tokensBefore: 1234, fromHook: true,
    details: { namespace: 'felan.session-compaction', schemaVersion: 1, method: 'summary', trace: 'private' } });
  expect(message).toMatchObject({ id: 'compact', entryId: 'compact', role: 'system', timestamp: 0,
    content: [{ type: 'text', text: 'Retained summary' }] });
  expect(message).not.toHaveProperty('customType');
  expect(message).not.toHaveProperty('details');
  expect(JSON.stringify(message)).not.toContain('private');
});

describe.skipIf(!supported)('Pi protocol projection', () => {
  it('preserves configured compaction metadata while the provider keeps implementation details private', async () => {
    const f = await fixture();
    const open = vi.mocked(f.profile.openSession).getMockImplementation()!;
    vi.mocked(f.profile.openSession).mockImplementation(async request => ({
      ...await open(request),
      projectMessage(entry, message) {
        if (entry.type !== 'compaction') return message;
        expect(entry.details).toEqual({ method: 'summary', trace: 'private' });
        return { ...message, customType: 'example.compaction.v1', details: { tokensBefore: entry.tokensBefore, method: 'Summary' } };
      },
    }));
    const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const manager = binding.runtime.session.sessionManager;
    const kept = manager.appendMessage({ role: 'user', content: 'Retain this', timestamp: 0 });
    const id = manager.appendCompaction('Retained summary', kept, 1234, { method: 'summary', trace: 'private' }, true);
    const projection = f.registry.projection(binding.sessionId);
    projection.refresh();
    const message = projection.snapshot().history.entries.find(entry => entry.entryId === id);
    expect(message).toMatchObject({ id, entryId: id, role: 'system', customType: 'example.compaction.v1',
      content: [{ type: 'text', text: 'Retained summary' }], details: { tokensBefore: 1234, method: 'Summary' } });
    expect(JSON.stringify(message)).not.toContain('private');
  });

  it('lists available models when no explicit model scope is configured', async () => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const session = binding.runtime.session;
    Object.assign(session, { modelRuntime: { getAvailableSnapshot: () => [offlineModel] } });
    expect(f.registry.projection(binding.sessionId).snapshot().catalog.models).toEqual([
      { provider: 'offline', id: 'fixture', label: 'Fixture', thinking: ['off'] },
    ]);
  });
  it('keeps an explicit model scope narrower than the available provider inventory', async () => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const session = binding.runtime.session;
    Object.assign(session, { scopedModels: [{ model: offlineModel }],
      modelRuntime: { getAvailableSnapshot: () => [{ ...offlineModel, id: 'outside-scope' }] } });
    expect(f.registry.projection(binding.sessionId).snapshot().catalog.models.map(model => model.id)).toEqual(['fixture']);
  });
  it('publishes streaming metadata without durable capacity and removes it only after message completion', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const runtime = f.instances.get(b.sessionId)!; const projection = f.registry.projection(b.sessionId);
    const message = assistant('Actual final answer');
    const spy = vi.spyOn(f.store, 'project').mockImplementationOnce(() => { throw new ControlStoreError('request_capacity', 'Control capacity is reserved for outcomes and safety operations.'); });
    runtime.emit({ type: 'message_start', message });
    expect(spy).not.toHaveBeenCalled();
    expect(() => f.registry.assertAdmission()).not.toThrow();
    spy.mockRestore(); projection.refresh();
    const current = projection.snapshot();
    expect(current.presentation).toContainEqual(expect.objectContaining({ id: MESSAGE_DISPLAY_ID,
      data: expect.objectContaining({ display: expect.objectContaining({ model: 'fixture', usage: message.usage }) }) }));
    const revision = current.revision;
    runtime.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Actual final answer', partial: message } });
    expect(projection.snapshot().revision).toBe(revision);
    runtime.emit({ type: 'message_end', message }); b.runtime.session.sessionManager.appendMessage(message); projection.refresh();
    const complete = projection.snapshot();
    expect(complete.presentation.some(item => item.id === MESSAGE_DISPLAY_ID)).toBe(false);
    expect(readMessageDisplay(complete.history.entries.at(-1)!.details)).toMatchObject({ kind: 'assistant', model: 'fixture', usage: message.usage });
  });
  it('publishes compaction progress without durable capacity and clears it on interruption', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const runtime = f.instances.get(b.sessionId)!; const projection = f.registry.projection(b.sessionId);
    const events: SessionEvent[] = []; f.registry.subscribe(b.sessionId, event => { if ('rev' in event) events.push(event); });
    const spy = vi.spyOn(f.store, 'project').mockImplementationOnce(() => { throw new ControlStoreError('request_capacity', 'Control capacity is reserved for outcomes and safety operations.'); });
    runtime.emit({ type: 'compaction_start', reason: 'manual' }); projection.refresh();
    expect(events.some(event => event.change.type === 'presentation.updated')).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(() => f.registry.assertAdmission()).not.toThrow(); spy.mockRestore(); projection.refresh();
    expect(projection.snapshot().presentation).toContainEqual({ id: 'compaction:progress', kind: 'status', key: 'compaction:progress', value: { kind: 'text', text: 'Compacting context…' }, fallback: 'Compacting context…' });
    runtime.emit({ type: 'compaction_end', reason: 'manual', result: undefined, aborted: true, willRetry: false }); projection.refresh();
    expect(projection.snapshot().presentation.some(item => item.id === 'compaction:progress')).toBe(false);
    expect(events.some(event => event.change.type === 'presentation.removed' && event.change.id === 'compaction:progress')).toBe(true);
  });
  it('maps actual Pi entries and coalesces tool output before durable publication', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const runtime = f.instances.get(b.sessionId)!;
    const events: SessionEvent[] = [];
    f.registry.subscribe(b.sessionId, event => {
      if ('rev' in event) { expect(f.store.session(b.sessionId).revision).toBe(event.rev); events.push(event); }
    });
    runtime.emit({ type: 'tool_execution_start', toolCallId: 't', toolName: 'read', args: {} });
    for (let n = 0; n < 30; n++) runtime.emit({ type: 'tool_execution_update', toolCallId: 't', toolName: 'read', args: {}, partialResult: { content: [{ type: 'text', text: `out${n}` }], details: {} } });
    runtime.emit({ type: 'tool_execution_end', toolCallId: 't', toolName: 'read', result: { content: [{ type: 'text', text: 'done' }], details: {} }, isError: false });
    f.registry.projection(b.sessionId).refresh();
    expect(events.filter(e => e.change.type === 'tool.updated')).toHaveLength(1);
    expect(f.registry.projection(b.sessionId).snapshot().tools[0]).toMatchObject({ state: 'completed', output: 'done' });
    await b.runtime.session.prompt('hello'); f.registry.projection(b.sessionId).refresh();
    const snapshot = parseSessionSnapshot(f.registry.projection(b.sessionId).snapshot());
    expect(snapshot.history.entries.map(entry => entry.role)).toEqual(['user', 'assistant']);
    expect(snapshot.history.entries[1]!.content).toEqual([{ type: 'text', text: 'done' }]);
    expect(snapshot.branch).toBe(b.runtime.session.sessionManager.getLeafId());
    expect(f.store.session(b.sessionId).projections.filter(row => row.value.type === 'message')).toHaveLength(2);
    expect(JSON.stringify(f.store.snapshot())).not.toContain('"text":"hello"');
  });

  it('retains complete codepoint prefixes without per-token durable writes', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } }); const runtime = f.instances.get(b.sessionId)!;
    const message = assistant('A😀'); runtime.emit({ type: 'message_start', message });
    const before = f.store.session(b.sessionId).revision;
    for (const delta of ['A', '😀']) runtime.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta, partial: message } });
    const snapshot = f.registry.projection(b.sessionId).snapshot();
    expect(snapshot.activeStreams[0]).toMatchObject({ text: 'A😀', offset: 2 });
    expect(snapshot.revision).toBe(before);
    runtime.emit({ type: 'message_end', message }); b.runtime.session.sessionManager.appendMessage(message);
    f.registry.projection(b.sessionId).refresh();
    expect(f.registry.projection(b.sessionId).snapshot().activeStreams).toEqual([]);
  });

  it('proves absence only against complete Pi entries, not an inactive branch', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    await b.runtime.session.prompt('branch one'); f.registry.projection(b.sessionId).refresh();
    const original = b.runtime.session.sessionManager.getLeafId()!;
    b.runtime.session.sessionManager.resetLeaf();
    await b.runtime.session.prompt('branch two'); f.registry.projection(b.sessionId).refresh();
    expect(await f.registry.evictIdle()).toEqual([b.sessionId]); await f.registry.restore(b.sessionId);
    expect(f.store.session(b.sessionId).projections.some(row => row.value.type === 'message' && row.value.entryId === original && row.value.state === 'observed')).toBe(true);
  });
  it('drops an over-limit prefix until completion and rejects stale history cursors', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } }); const runtime = f.instances.get(b.sessionId)!;
    const message = assistant('large'); runtime.emit({ type: 'message_start', message });
    runtime.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x'.repeat(1024 * 1024 + 1), partial: message } });
    runtime.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'tail', partial: message } });
    expect(f.registry.projection(b.sessionId).snapshot()).toMatchObject({ activeStreams: [], completionOnlyStreams: [{ reason: 'limit' }] });
    expect(() => f.registry.projection(b.sessionId).history('not-a-cursor')).toThrow('resync_required');
    runtime.emit({ type: 'message_end', message }); b.runtime.session.sessionManager.appendMessage(message);
    f.registry.projection(b.sessionId).refresh();
    expect(f.registry.projection(b.sessionId).snapshot().completionOnlyStreams).toEqual([]);
  });

  it('retains a capacity-blocked completion-only notification and final message without fencing', async () => {
    const f = await fixture({ capacity: { bytes: 2_200_000 } });
    const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } }); const runtime = f.instances.get(b.sessionId)!;
    const gate = deferred(); f.releases.add(gate.resolve); const id = requestId();
    const events: SessionEvent[] = [];
    f.registry.subscribe(b.sessionId, event => { if ('rev' in event) events.push(event); });
    f.store.admit({ v: 1, id, op: 'prompt', session: b.sessionId, params: { text: 'held' } }, 'owner');
    const work = f.registry.runAdmitted(id, b.sessionId, { kind: 'headless', attachment: 'fixture' }, () => gate.promise);
    const safety = requestId(); f.store.admit({ v: 1, id: safety, op: 'cancel', session: b.sessionId, params: {} }, 'owner'); f.store.markDispatched(safety);
    const message = assistant('authoritative final'); runtime.emit({ type: 'message_start', message });
    runtime.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x'.repeat(1024 * 1024 + 1), partial: message } });
    runtime.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'ignored tail', partial: message } });
    expect(() => f.registry.assertAdmission()).not.toThrow();
    expect(f.registry.projection(b.sessionId).snapshot()).toMatchObject({ activeStreams: [], completionOnlyStreams: [{ reason: 'limit' }] });
    expect(events.some(event => event.change.type === 'stream.completion_only')).toBe(false);
    runtime.emit({ type: 'message_end', message }); b.runtime.session.sessionManager.appendMessage(message);
    gate.resolve(); await work;
    for (const request of [id, safety]) f.store.finishRequest(request, { v: 1, re: request, outcome: 'rejected', error: { code: 'unavailable', message: 'test completed', retryable: true } });
    await vi.waitFor(() => expect(events.filter(event => event.change.type === 'message.completed')).toHaveLength(1));
    const relevant = events.filter(event => event.change.type === 'stream.completion_only' || event.change.type === 'message.completed');
    expect(relevant.map(event => event.change.type)).toEqual(['stream.completion_only', 'message.completed']);
    const overflow = relevant[0]!.change; const completed = relevant[1]!.change;
    if (overflow.type !== 'stream.completion_only' || completed.type !== 'message.completed') throw new Error('Missing completion evidence');
    expect(overflow.stream.message).toBe(completed.message.id);
    expect(completed.message.content).toEqual([{ type: 'text', text: 'authoritative final' }]);
    expect(f.registry.projection(b.sessionId).snapshot()).toMatchObject({ activeStreams: [], completionOnlyStreams: [] });
    expect(JSON.stringify(f.store.snapshot())).not.toContain('ignored tail');
  });

  for (const code of ['storage_failure', 'ownership_lost', 'invalid_request', 'request_capacity'] as const) {
    it(`keeps ${code} outside exact transient capacity fatal during stream overflow`, async () => {
      const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
      const spy = vi.spyOn(f.store, 'project').mockImplementationOnce(() => { throw new ControlStoreError(code, 'not transient capacity'); });
      const runtime = f.instances.get(b.sessionId)!; const message = assistant();
      runtime.emit({ type: 'message_start', message });
      runtime.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x'.repeat(1024 * 1024 + 1), partial: message } });
      spy.mockRestore();
      expect(() => f.registry.assertAdmission()).toThrow('not admitting');
      await f.registry.settleWriters();
      const fault = f.registry as unknown as { failure?: unknown; failureSettlement?: Promise<void> };
      delete fault.failure; delete fault.failureSettlement;
    });
  }

});
