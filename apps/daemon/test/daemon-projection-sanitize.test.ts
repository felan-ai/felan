import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '@felan-ai/agent-core';
import { LIMITS, MessageSchema, encodeFrame, parseSchema, parseSessionEvent, parseSessionSnapshot, validateBase64, type Message, type Origin, type SessionEvent } from '@felan-ai/session-protocol';
import { projectPiMessage, SessionProjection } from '../src/daemon/projection.js';
import { sanitizeMessage, toolId, toolName } from '../src/daemon/message-sanitize.js';
import { assistant, fixture, fixtures, offlineModel, requestId, supported } from './fixtures/registry.js';

afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of fixtures.splice(0)) await cleanup(); });

function entry(message: unknown): Extract<core.SessionEntry, { type: 'message' }> {
  return { type: 'message', id: 'entry', parentId: 'parent', timestamp: new Date(123).toISOString(), message } as Extract<core.SessionEntry, { type: 'message' }>;
}
function nested(depth: number): unknown { let value: unknown = 'leaf'; while (depth-- > 0) value = { next: value }; return value; }
function framed(message: Message): unknown {
  return { v: 1, re: 'request', outcome: 'accepted', result: { attachmentId: 'attachment', snapshot: { history: { entries: [message] } } } };
}

describe('message sanitization', () => {
  it.each(['', `call|${'x'.repeat(500)}`, '界'.repeat(60)])('maps invalid tool ids deterministically: %j', id => {
    const call = projectPiMessage(entry({ ...assistant(), content: [{ type: 'toolCall', id, name: 'tool', arguments: {} }] }));
    const result = projectPiMessage(entry({ role: 'toolResult', toolCallId: id, toolName: 'tool', content: [], isError: false, timestamp: 0 }));
    expect(call.content[0]).toMatchObject({ type: 'tool_call', id: expect.any(String) });
    const mapped = (call.content[0] as { id: string }).id;
    expect(mapped).not.toBe(id);
    expect(Buffer.byteLength(mapped)).toBeGreaterThan(0);
    expect(Buffer.byteLength(mapped)).toBeLessThanOrEqual(LIMITS.idBytes);
    expect(result.content[0]).toMatchObject({ type: 'tool_result', id: mapped });
    expect(projectPiMessage(entry({ ...assistant(), content: [{ type: 'toolCall', id, name: 'tool', arguments: {} }] }))).toEqual(call);
  });

  it.each(['', '界'.repeat(60)])('bounds empty and overlong tool names: %j', name => {
    const message = projectPiMessage(entry({ ...assistant(), content: [{ type: 'toolCall', id: 'call', name, arguments: {} }] }));
    const part = message.content[0] as { name: string };
    expect(part.name.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(part.name)).toBeLessThanOrEqual(LIMITS.commandBytes);
    expect(parseSchema(MessageSchema, message)).toEqual(message);
  });

  it.each([undefined, null, 17, {}, [], Symbol('tool')])('handles non-string tool ids and names: %s', value => {
    expect(toolName(value)).toBe('unknown');
    const id = toolId(value);
    expect(toolId(value)).toBe(id);
    const call = projectPiMessage(entry({ ...assistant(), content: [{ type: 'toolCall', id: value, name: value, arguments: {} }] }));
    const result = projectPiMessage(entry({ role: 'toolResult', toolCallId: value, toolName: value, content: [], isError: false, timestamp: 0 }));
    expect(call.content[0]).toMatchObject({ type: 'tool_call', id, name: 'unknown' });
    expect(result.content[0]).toMatchObject({ type: 'tool_result', id });
    expect(parseSchema(MessageSchema, call)).toEqual(call);
  });

  it.each([
    { mimeType: 'image/jpg', data: 'Y Q==\n', expected: { type: 'image', mimeType: 'image/jpeg', data: 'YQ==' } },
    { mimeType: 'image/png', data: 'data:image/png;base64,YQ==', expected: { type: 'image', mimeType: 'image/png', data: 'YQ==' } },
    { mimeType: 'image/svg+xml', data: 'PHN2Zz4=', expected: { type: 'text', text: '[Image omitted: unsupported format]' } },
    { mimeType: 'image/png', data: '@@@', expected: { type: 'text', text: '[Image omitted: invalid data]' } },
    { mimeType: 'image/png', data: 'YR==', expected: { type: 'text', text: '[Image omitted: invalid data]' } },
    { mimeType: 'image/png', data: 'data:image/jpeg;base64,YQ==', expected: { type: 'text', text: '[Image omitted: invalid data]' } },
    ...['', ' \n', 'data:image/png;base64,'].map(data => ({ mimeType: 'image/png', data, expected: { type: 'text', text: '[Image omitted: invalid data]' } })),
  ])('normalizes or omits $mimeType images with $data', ({ mimeType, data, expected }) => {
    for (const raw of [
      { role: 'user', content: [{ type: 'image', mimeType, data }], timestamp: 0 },
      { role: 'toolResult', toolCallId: 'call', toolName: 'tool', content: [{ type: 'image', mimeType, data }], timestamp: 0, isError: false },
    ]) {
      const message = projectPiMessage(entry(raw));
      expect(message.content).toContainEqual(expected);
      expect(parseSchema(MessageSchema, message)).toEqual(message);
      for (const part of message.content) if (part.type === 'image') expect(() => validateBase64(part.data)).not.toThrow();
    }
  });

  it('converts live arguments and details to plain JSON without mutating canonical values', () => {
    class JsonForm { toJSON() { return { retained: true, absent: undefined }; } }
    class PlainForm { retained = true; }
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const value = { absent: undefined, nan: NaN, infinity: Infinity, date: new Date(0), json: new JsonForm(), plain: new PlainForm(),
      array: [undefined, Infinity], text: '\ud800', ['bad\ud800']: 'key', ['__proto__']: 'unsafe', cycle, deep: nested(48) };
    const expected = { nan: null, infinity: null, date: new Date(0).toISOString(), json: { retained: true }, plain: { retained: true },
      array: [null, null], text: '�', ['bad�']: 'key', cycle: { self: '[Circular data omitted]' } };
    const call = projectPiMessage(entry({ ...assistant(), content: [{ type: 'toolCall', id: 'call', name: 'tool', arguments: value }] }));
    expect(call.content[0]).toMatchObject({ arguments: expected });
    const tool = projectPiMessage(entry({ role: 'toolResult', toolCallId: 'call', toolName: 'tool', content: [], timestamp: 0, isError: false, details: value }));
    expect(tool.content[0]).toMatchObject({ details: expected });
    expect(tool.details).toMatchObject(expected);
    expect(JSON.stringify(call)).toContain('[Nested data omitted]');
    expect(() => encodeFrame(framed(call))).not.toThrow();
    expect(() => encodeFrame(framed(tool))).not.toThrow();
    expect(value.nan).toBeNaN(); expect(value.text).toBe('\ud800'); expect(value.cycle.self).toBe(cycle);
  });

  it('uses an identity-preserving fallback when a message still fails validation', () => {
    const message = projectPiMessage(entry({ role: 'user', content: [{ type: 'text', text: 17 }], timestamp: 0 }));
    expect(message).toEqual({ id: 'entry', entryId: 'entry', parentEntryId: 'parent', role: 'user', timestamp: 123,
      content: [{ type: 'text', text: '[Message could not be displayed.]' }] });
    expect(parseSchema(MessageSchema, message)).toEqual(message);
  });
});

describe.skipIf(!supported)('sanitized session projections', () => {
  it('repairs malformed session titles before storing or publishing, including after reopen', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } }); const id = b.sessionId;
    const manager = b.runtime.session.sessionManager; const projection = f.registry.projection(id);
    await b.runtime.session.prompt('persist the session'); projection.refresh();
    const events: SessionEvent[] = []; f.registry.subscribe(id, event => { if ('change' in event) events.push(event); });
    const diagnostic = vi.fn(); f.registry.options.onDiagnostic = diagnostic;
    const malformed = `${'界'.repeat(69)}\ud83d`;
    manager.appendSessionInfo(malformed);
    expect(() => projection.refresh()).not.toThrow();
    expect(manager.getSessionName()).toBe(malformed);
    const repaired = `${'界'.repeat(69)}�`;
    expect(f.store.sessionMetadata(id).title).toBe(repaired);
    expect(parseSessionSnapshot(projection.snapshot()).title).toBe(repaired);
    const updates = events.filter(event => event.change.type === 'metadata.updated');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.change).toMatchObject({ title: repaired });
    for (const event of events) expect(parseSessionEvent(event)).toEqual(event);
    await f.registry.settleWriters(); await f.registry.close(id); await f.registry.restore(id);
    expect(f.registry.projection(id).snapshot().title).toBe(repaired);
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it.each([17, false, {}, ['title']])('treats a non-string session name as empty: %j', async name => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const manager = b.runtime.session.sessionManager; const projection = f.registry.projection(b.sessionId);
    await b.runtime.session.prompt('persist the session');
    manager.appendSessionInfo('before'); projection.refresh();
    expect(f.store.sessionMetadata(b.sessionId).title).toBe('before');
    const events: SessionEvent[] = []; f.registry.subscribe(b.sessionId, event => { if ('change' in event) events.push(event); });
    vi.spyOn(manager, 'getSessionName').mockReturnValue(name as never);
    expect(() => projection.refresh()).not.toThrow();
    expect(f.store.sessionMetadata(b.sessionId).title).toBe('');
    expect(parseSessionSnapshot(projection.snapshot()).title).toBe('');
    expect(events.find(event => event.change.type === 'metadata.updated')?.change).toMatchObject({ title: '' });
    for (const event of events) expect(parseSessionEvent(event)).toEqual(event);
  });

  it('reuses projections without changing history pages, origins or provider results', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const manager = b.runtime.session.sessionManager; const projection = f.registry.projection(b.sessionId);
    const decorate = (_entry: core.SessionEntry, message: Message): Message => ({ ...message, details: { decorated: true, original: message.details ?? null } });
    const project = vi.fn(decorate); Object.assign(b, { projectMessage: project });
    const first = manager.appendMessage({ role: 'user', content: 'first', timestamp: 0 });
    const unobserved = projection.history().entries[0]!;
    expect(unobserved.origin).toBeUndefined();
    const origin: Origin = { kind: 'automation', source: 'runtime' };
    projection.setOrigin(origin); projection.refresh();
    manager.appendMessage(assistant('second')); projection.refresh();
    const all = projection.history();
    const expected = manager.getBranch().filter(item => item.type === 'message').map(item => {
      const message = projectPiMessage(item, all.entries.find(value => value.entryId === item.id)!.id, origin);
      return sanitizeMessage(decorate(item, message), message);
    });
    expect(all.entries).toEqual(expected);
    expect(all.entries.find(message => message.entryId === first)?.origin).toEqual(origin);
    project.mockClear();
    const last = projection.history(undefined, all.revision, 1);
    expect(last.entries).toEqual(expected.slice(-1)); expect(last.cursor).toBeDefined();
    const previous = projection.history(last.cursor, all.revision, 1);
    expect(previous.entries).toEqual(expected.slice(0, 1)); expect(previous.cursor).toBeUndefined();
    expect(projection.history().entries).toEqual(expected);
    expect(project).not.toHaveBeenCalled();
    const replacement = vi.fn((_entry: core.SessionEntry, message: Message): Message => ({ ...message, details: { replacement: true } }));
    Object.assign(b, { projectMessage: replacement });
    expect(projection.history().entries.every(message => (message.details as { replacement: boolean }).replacement)).toBe(true);
    expect(replacement).toHaveBeenCalledTimes(2);
  });

  it('reuses projections across entry wrappers but invalidates a replaced source', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const projection = f.registry.projection(b.sessionId);
    const project = vi.fn((_entry: core.SessionEntry, message: Message) => message); Object.assign(b, { projectMessage: project });
    const original = entry({ role: 'user', content: 'original', timestamp: 0 });
    const branch = vi.spyOn(b.runtime.session.sessionManager, 'getBranch').mockReturnValue([original]);
    const first = projection.history(); project.mockClear();
    branch.mockReturnValue([{ ...original }]);
    expect(projection.history()).toEqual(first); expect(project).not.toHaveBeenCalled();
    const replaced = entry({ role: 'user', content: 'replaced', timestamp: 0 });
    branch.mockReturnValue([replaced]);
    expect(projection.history().entries).toEqual([projectPiMessage(replaced)]); expect(project).toHaveBeenCalledTimes(1);
    project.mockClear();
    expect(projection.history().entries).toEqual([projectPiMessage(replaced)]); expect(project).not.toHaveBeenCalled();
  });

  it.each([
    { bound: 'entry count', count: 2 * LIMITS.pageEntries + 1, textBytes: 32 },
    { bound: 'bytes', count: 5, textBytes: LIMITS.pageBytes / 4 - 1024 },
  ])('evicts the least recently used projections by $bound without changing history', async ({ count, textBytes }) => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const manager = b.runtime.session.sessionManager; const projection = f.registry.projection(b.sessionId);
    const project = vi.fn((_entry: core.SessionEntry, message: Message) => message); Object.assign(b, { projectMessage: project });
    for (let index = 0; index < count; index++) manager.appendMessage({ role: 'toolResult', toolCallId: `call-${index}`, toolName: 'tool',
      content: [{ type: 'text', text: 'x'.repeat(textBytes) }], timestamp: index, isError: false });
    const expected = manager.getBranch().filter(item => item.type === 'message').map(item => projectPiMessage(item));
    const limit = (count - 1) / 2;
    const latest = projection.history(undefined, undefined, limit); expect(latest.cursor).toBeDefined();
    const previous = projection.history(latest.cursor, latest.revision, limit); expect(previous.cursor).toBeDefined();
    expect([...previous.entries, ...latest.entries]).toEqual(expected.slice(1));
    expect(projection.history(undefined, latest.revision, 1).entries).toEqual(expected.slice(-1));
    project.mockClear();
    expect(projection.history(previous.cursor).entries).toEqual(expected.slice(0, 1));
    expect(project).toHaveBeenCalledTimes(1);
    project.mockClear();
    expect(projection.history(undefined, latest.revision, 2).entries).toEqual(expected.slice(-2));
    expect(project.mock.calls.map(([item]) => item.id)).toEqual([expected.at(-2)!.entryId]);
    const all: Message[] = []; let page = projection.history();
    while (true) { all.unshift(...page.entries); if (!page.cursor) break; page = projection.history(page.cursor); }
    expect(all).toEqual(expected);
  });

  it('caches older streamed messages after more than 256 completed streams', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const runtime = f.instances.get(b.sessionId)!; const projection = f.registry.projection(b.sessionId);
    const project = vi.fn((_entry: core.SessionEntry, message: Message) => message); Object.assign(b, { projectMessage: project });
    const messages = Array.from({ length: 257 }, (_, index) => assistant(`message ${index}`));
    for (const message of messages) {
      runtime.emit({ type: 'message_start', message }); runtime.emit({ type: 'message_end', message });
    }
    for (const message of messages) runtime.session.sessionManager.appendMessage(message);
    projection.refresh();
    const latest = projection.history(); expect(latest.cursor).toBeDefined();
    const oldest = projection.history(latest.cursor);
    expect(oldest.entries).toHaveLength(1); expect(oldest.entries[0]!.content).toEqual([{ type: 'text', text: 'message 0' }]);
    project.mockClear();
    expect(projection.history(latest.cursor)).toEqual(oldest);
    expect(projection.snapshot().history).toEqual(latest);
    expect(project).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not reuse stale live content after completion, previously cached: %s', async previouslyCached => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const runtime = f.instances.get(b.sessionId)!; const projection = f.registry.projection(b.sessionId);
    const project = vi.fn((_entry: core.SessionEntry, message: Message) => message); Object.assign(b, { projectMessage: project });
    const message = assistant('partial');
    let id: string;
    if (previouslyCached) {
      id = runtime.session.sessionManager.appendMessage(message);
      projection.history();
      runtime.emit({ type: 'message_start', message });
    } else {
      runtime.emit({ type: 'message_start', message });
      id = runtime.session.sessionManager.appendMessage(message);
    }
    const live = projection.history().entries[0]!;
    if (!previouslyCached) expect(live.id).not.toBe(id);
    expect(live).toEqual(projectPiMessage(runtime.session.sessionManager.getEntry(id) as ReturnType<typeof entry>, live.id));
    message.content = [{ type: 'text', text: 'complete' }];
    expect(projection.history().entries[0]).toEqual(projectPiMessage(runtime.session.sessionManager.getEntry(id) as ReturnType<typeof entry>, live.id));
    runtime.emit({ type: 'message_end', message }); projection.refresh();
    const complete = projection.history().entries[0]!; project.mockClear();
    expect(complete.id).toBe(live.id); expect(complete.content).toEqual([{ type: 'text', text: 'complete' }]);
    expect(projection.history().entries[0]).toEqual(complete);
    expect(project).not.toHaveBeenCalled();
  });

  it('keeps tool states, completion, history pages and reopened history linked and accepts a later prompt', async () => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const id = binding.sessionId; const runtime = f.instances.get(id)!; const manager = runtime.session.sessionManager;
    const projection = f.registry.projection(id); const diagnostic = vi.fn(); f.registry.options.onDiagnostic = diagnostic;
    const events: SessionEvent[] = []; f.registry.subscribe(id, event => { if ('change' in event) events.push(event); });
    const toolCallId = `call|${'x'.repeat(500)}`;
    const message = { ...assistant(), content: [{ type: 'toolCall' as const, id: toolCallId, name: '', arguments: { deep: nested(48) } }] };
    runtime.emit({ type: 'message_start', message }); runtime.emit({ type: 'message_end', message });
    const assistantId = manager.appendMessage(message); projection.refresh();
    runtime.emit({ type: 'tool_execution_start', toolCallId, toolName: '', args: {} });
    const result = { content: [{ type: 'text' as const, text: 'done\ud800' }], details: {} };
    runtime.emit({ type: 'tool_execution_update', toolCallId, toolName: '', args: {}, partialResult: result });
    runtime.emit({ type: 'tool_execution_end', toolCallId, toolName: '', result, isError: false });
    manager.appendMessage({ role: 'toolResult', toolCallId, toolName: '', content: [{ type: 'image', mimeType: 'image/svg+xml', data: 'PHN2Zz4=' }], timestamp: 0, isError: false });
    projection.refresh(); await f.registry.settleWriters();
    const attached = await f.registry.attach(id, { principal: 'fixture', kind: 'headless' });
    const snapshot = attached.snapshot; const call = snapshot.history.entries.find(item => item.entryId === assistantId)!;
    const mapped = (call.content[0] as { id: string }).id;
    expect(snapshot.tools).toEqual([{ id: mapped, name: 'unknown', message: call.id, state: 'completed', output: 'done�', truncated: false }]);
    expect(snapshot.history.entries.at(-1)!.content).toContainEqual({ type: 'tool_result', id: mapped, text: '', isError: false });
    expect(parseSessionSnapshot(snapshot)).toEqual(snapshot);
    expect(() => encodeFrame({ v: 1, re: 'attach', outcome: 'accepted', result: { attachmentId: attached.attachment, snapshot } })).not.toThrow();
    const page = projection.history(undefined, snapshot.revision, 1);
    expect(page.cursor).toBeDefined();
    expect(projection.history(page.cursor, snapshot.revision, 1).entries[0]).toEqual(call);
    for (const event of events) { expect(parseSessionEvent(event)).toEqual(event); expect(() => encodeFrame(event)).not.toThrow(); }
    expect(events.some(event => event.change.type === 'tool.updated' && event.change.tool.id === mapped && event.change.tool.message === call.id)).toBe(true);
    f.registry.detach(id, attached.attachment); await f.registry.close(id); await f.registry.restore(id);
    expect(f.registry.projection(id).snapshot().history.entries.find(item => item.entryId === assistantId)?.content[0]).toMatchObject({ id: mapped });
    const request = requestId(); f.store.admit({ v: 1, id: request, op: 'prompt', session: id, params: { text: 'later prompt' } }, 'fixture');
    await f.registry.runAdmitted(request, id, { kind: 'headless', attachment: 'fixture' }, session => session.prompt('later prompt'));
    await f.registry.settleWriters();
    expect(f.registry.projection(id).snapshot().history.entries.some(item => item.content.some(part => part.type === 'text' && part.text === 'later prompt'))).toBe(true);
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it('falls back for throwing or identity-changing provider projections', async () => {
    const f = await fixture(); const open = vi.mocked(f.profile.openSession).getMockImplementation()!;
    vi.mocked(f.profile.openSession).mockImplementation(async request => ({ ...await open(request), projectMessage(entry, message) {
      if (entry.type === 'message' && entry.message.role === 'user') throw new Error('bad provider projection');
      return { ...message, id: 'changed' };
    } }));
    const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    await b.runtime.session.prompt('still usable');
    const messages = f.registry.projection(b.sessionId).snapshot().history.entries;
    expect(messages).toHaveLength(2);
    for (const message of messages) expect(message.content).toEqual([{ type: 'text', text: '[Message could not be displayed.]' }]);
  });

  it('rejects in-place identity changes by provider projections', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    Object.assign(b, { projectMessage(_entry: core.SessionEntry, message: Message) { message.id = 'changed'; return message; } });
    const entryId = b.runtime.session.sessionManager.appendMessage({ role: 'user', content: 'original', timestamp: 0 });
    const projected = f.registry.projection(b.sessionId).history().entries[0]!;
    expect(projected.id).toBe(entryId);
    expect(projected.content).toEqual([{ type: 'text', text: '[Message could not be displayed.]' }]);
  });

  it('normalizes catalog parameters and missing descriptions but drops invalid activation names', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } }); const session = b.runtime.session;
    const levels = core.getSupportedThinkingLevels;
    vi.spyOn(core, 'getSupportedThinkingLevels').mockImplementation(model => model.id === 'bad-thinking' ? ['unknown' as never] : levels(model));
    Object.assign(session, {
      getAllTools: () => [
        { name: 'valid', description: 'valid', parameters: {} },
        ...['', '界'.repeat(60), 'x'.repeat(129), 'bad\ud800'].map(name => ({ name, description: 'invalid name', parameters: {} })),
        ...[{ missing: undefined }, { invalid: Infinity }, new Date(0), nested(48)].map((parameters, index) => ({ name: `parameters-${index}`, description: 'normalized JSON', parameters })),
        { name: 'no-description', parameters: {} },
      ],
      extensionRunner: { getRegisteredCommands: () => [{ name: 'valid', description: 'valid' }, { name: '', description: '' }, { name: 'x'.repeat(129), description: '' }] },
      modelRuntime: { getAvailableSnapshot: () => [offlineModel, { ...offlineModel, id: '' }, { ...offlineModel, provider: '界'.repeat(60) }, { ...offlineModel, id: 'bad-thinking' }] },
    });
    const projection = new SessionProjection({ binding: b, store: f.store, extras: () => ({ children: [], processes: [], interactions: [] }), publish() {}, onError(error) { throw error; }, commandAvailable: () => true });
    try {
      const catalog = projection.catalog();
      expect(catalog.tools.map(tool => tool.name)).toEqual(['valid', 'parameters-0', 'parameters-1', 'parameters-2', 'parameters-3', 'no-description']);
      expect(catalog.tools.slice(1, 4).map(tool => tool.parameters)).toEqual([{}, { invalid: null }, new Date(0).toISOString()]);
      expect(JSON.stringify(catalog.tools[4]!.parameters)).toContain('[Nested data omitted]');
      expect(catalog.tools[5]!.description).toBe('');
      expect(catalog.commands).toMatchObject([{ name: 'valid' }]); expect(catalog.models).toMatchObject([{ id: 'fixture' }]);
      expect(catalog.commands).toHaveLength(1); expect(catalog.models).toHaveLength(1);
      expect(() => encodeFrame({ v: 1, session: b.sessionId, rev: 1, change: { type: 'catalog.updated', catalog } })).not.toThrow();
      expect(() => projection.refresh()).not.toThrow();
    } finally { projection.dispose(); }
  });

  it('skips invalid model updates, retains the last valid model, and resumes valid updates', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } }); const projection = f.registry.projection(b.sessionId);
    const events: SessionEvent[] = []; f.registry.subscribe(b.sessionId, event => { if ('change' in event) events.push(event); });
    const valid = projection.snapshot().model;
    Object.assign(b.runtime.session, { model: { ...offlineModel, id: 'x'.repeat(129) }, thinkingLevel: 'high' });
    expect(() => projection.refresh()).not.toThrow(); expect(projection.snapshot().model).toEqual(valid);
    expect(events.some(event => event.change.type === 'model.updated')).toBe(false);
    Object.assign(b.runtime.session, { model: { ...offlineModel, id: 'valid-new' }, thinkingLevel: 'unsupported' });
    expect(() => projection.refresh()).not.toThrow(); expect(projection.snapshot().model).toEqual(valid);
    Object.assign(b.runtime.session, { thinkingLevel: 'off' }); projection.refresh();
    expect(projection.snapshot().model.id).toBe('valid-new');
  });

  it('keeps missing-model snapshots explicit until a representable model is selected', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const metadata = f.store.sessionMetadata.bind(f.store);
    const missing = vi.spyOn(f.store, 'sessionMetadata').mockImplementation(id => {
      const { model, thinking, ...value } = metadata(id); return value;
    });
    Object.assign(b.runtime.session, { model: { ...offlineModel, id: 'x'.repeat(129) } });
    const projection = f.registry.projection(b.sessionId);
    expect(() => projection.refresh()).not.toThrow();
    expect(() => projection.snapshot()).toThrow('Session has no selected model; select an available model before attaching.');
    expect(() => f.registry.assertDispatch(b.sessionId)).not.toThrow();
    missing.mockRestore();
    Object.assign(b.runtime.session, { model: offlineModel });
    expect(projection.snapshot().model).toEqual({ provider: 'offline', id: 'fixture' });
  });
});
