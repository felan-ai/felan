import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, MESSAGE_DISPLAY_KEY, MESSAGE_DISPLAY_ID, codePointLength, encodeFrame, parseOperationResult, parseSessionSnapshot, readMessageDisplay, type SessionEvent, type TextStreamEvent } from '@felan-ai/session-protocol';
import { ControlStoreError } from '../src/daemon/control-state.js';
import { projectPiMessage, SessionProjection } from '../src/daemon/projection.js';
import type { SessionEntry } from '@felan-ai/agent-core';
import { assistant, deferred, fixture, fixtures, offlineModel, requestId, supported } from './fixtures/registry.js';
import { readControlDatabase } from './fixtures/control-database.js';

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
  it.runIf(process.env.FELAN_ATTACH_BENCHMARK === '1')('benchmarks attach snapshot validation at five MiB', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const projection = f.registry.projection(b.sessionId); const runtime = f.instances.get(b.sessionId)!;
    const text = 'x'.repeat(1024 * 1024);
    b.runtime.session.sessionManager.appendMessage({ role: 'user', content: text, timestamp: 0 });
    const message = assistant('Pending'); runtime.emit({ type: 'message_start', message });
    for (let contentIndex = 0; contentIndex < 4; contentIndex++) runtime.emit({ type: 'message_update', message,
      assistantMessageEvent: { type: 'text_delta', contentIndex, delta: text, partial: message } });
    const snapshot = projection.snapshot();
    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    expect(bytes).toBeGreaterThanOrEqual(5 * 1024 * 1024);
    expect(parseSessionSnapshot(snapshot)).toEqual(snapshot);
    for (const [name, parse] of [
      ['parseSessionSnapshot', () => parseSessionSnapshot(snapshot)],
      ['parseOperationResult(attach)', () => parseOperationResult('attach', { attachmentId: 'attachment', snapshot })],
    ] as const) {
      for (let warmup = 0; warmup < 20; warmup++) parse();
      const samples: number[] = [];
      for (let sample = 0; sample < 50; sample++) {
        const start = performance.now(); parse(); samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      console.log(JSON.stringify({ validator: name, attachSnapshotBytes: bytes, validationSamples: samples.length,
        validationMedianMs: samples[25], validationP95Ms: samples[47] }));
    }
  });

  it.runIf(process.env.FELAN_PROJECTION_BENCHMARK === '1')('benchmarks unchanged catalog refreshes and incremental streaming', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const session = b.runtime.session; const runtime = f.instances.get(b.sessionId)!; const projection = f.registry.projection(b.sessionId);
    const parameters = { type: 'object', properties: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
      `option${index}`, { type: 'string', description: `Tool option ${index}`, enum: ['first', 'second', 'third'] },
    ])), required: ['option0'] };
    Object.assign(session, { getAllTools: () => Array.from({ length: 60 }, (_, index) => ({ name: `tool${index}`, description: `Tool ${index}`, parameters })) });
    for (let index = 0; index < 256; index++) session.sessionManager.appendMessage({ role: 'user', content: `Message ${index}`, timestamp: index });
    projection.refresh();
    for (let index = 0; index < 100; index++) projection.refresh();
    const median = (times: number[]) => times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
    const refreshTimes: number[] = [];
    for (let sample = 0; sample < 5; sample++) {
      const start = performance.now();
      for (let index = 0; index < 500; index++) projection.refresh();
      refreshTimes.push((performance.now() - start) / 500);
    }
    const deltaTimes: Record<string, number> = {};
    for (const size of [100, 200, 400]) {
      const times: number[] = [];
      const text = 'x'.repeat(size * 1024); const delta = 'x'.repeat(25);
      for (let sample = 0; sample < 5; sample++) {
        const message = assistant(text); runtime.emit({ type: 'message_start', message });
        const start = performance.now();
        for (let index = 0; index < text.length; index += delta.length) runtime.emit({ type: 'message_update', message,
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text.slice(index, index + delta.length), partial: message } });
        times.push(performance.now() - start);
        expect(projection.snapshot().activeStreams[0]?.text).toBe(text);
        runtime.emit({ type: 'message_end', message }); session.sessionManager.appendMessage(message); projection.refresh();
      }
      deltaTimes[`${size}KiB`] = median(times);
    }
    console.log(JSON.stringify({ refreshMedianMs: median(refreshTimes), deltaMedianMs: deltaTimes }));
  }, 60_000);

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
  it('publishes catalog changes only when tool, command, skill or model content changes', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const session = b.runtime.session; const projection = f.registry.projection(b.sessionId);
    const tools = [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
    const active = ['read'];
    const commands = [{ name: 'fixture', description: 'Fixture command', sourceInfo: { path: '/fixture', scope: 'project' } }];
    const skills = [{ name: 'review', description: 'Review code', filePath: '/review', sourceInfo: { scope: 'project' } }];
    const models = [offlineModel];
    let enabled = true;
    Object.assign(session, { getAllTools: () => tools, getActiveToolNames: () => active,
      extensionRunner: { getRegisteredCommands: () => commands }, resourceLoader: { getSkills: () => ({ skills }) },
      modelRuntime: { getAvailableSnapshot: () => models } });
    const stop = f.registry.bindCommandDispatcher(() => enabled);
    const events: SessionEvent[] = [];
    f.registry.subscribe(b.sessionId, event => { if ('change' in event && event.change.type === 'catalog.updated') events.push(event); });
    const initial = projection.snapshot();
    projection.refresh();
    expect(projection.snapshot().catalog).toBe(initial.catalog);
    expect(events).toHaveLength(0);
    tools[0]!.parameters.properties.path.type = 'number'; projection.refresh();
    expect(events).toHaveLength(1);
    active.length = 0; projection.refresh();
    expect(events).toHaveLength(2);
    commands[0]!.description = 'Changed command';
    const catalog = projection.catalog();
    expect(catalog.commands[0]?.description).toBe('Changed command');
    expect(projection.catalog()).toBe(catalog);
    expect(events).toHaveLength(2);
    projection.refresh();
    expect(events).toHaveLength(3);
    skills[0]!.description = 'Changed skill'; projection.refresh();
    expect(events).toHaveLength(4);
    models.push({ ...offlineModel, id: 'another' }); projection.refresh();
    expect(events).toHaveLength(5);
    enabled = false; projection.refresh();
    expect(events).toHaveLength(6);
    const final = projection.snapshot();
    expect(final.catalog).toMatchObject({ tools: [{ active: false, parameters: { properties: { path: { type: 'number' } } } }], commands: [] });
    expect(final.catalog.models.map(model => model.id)).toEqual(['fixture', 'another']);
    expect(final.revision).toBe(initial.revision + events.length);
    expect(parseSessionSnapshot(final)).toEqual(final);
    projection.refresh(); expect(events).toHaveLength(6);
    stop();
  });
  it('returns valid snapshots without full session reads and keeps previous tool snapshots stable', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const runtime = f.instances.get(b.sessionId)!; const projection = f.registry.projection(b.sessionId);
    const read = vi.spyOn(f.store, 'session');
    try {
      await b.runtime.session.prompt('hello');
      const message = assistant('A😀'); runtime.emit({ type: 'message_start', message });
      runtime.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'A😀', partial: message } });
      runtime.emit({ type: 'tool_execution_start', toolCallId: 'read', toolName: 'read', args: {} });
      projection.setPresentation({ id: 'notice', kind: 'notification', level: 'info', text: 'Ready' });
      const snapshot = projection.snapshot();
      expect(parseSessionSnapshot(snapshot)).toEqual(snapshot);
      runtime.emit({ type: 'tool_execution_end', toolCallId: 'read', toolName: 'read', result: { content: [{ type: 'text', text: 'Output' }], details: {} }, isError: false });
      const completed = projection.snapshot();
      expect(parseSessionSnapshot(completed)).toEqual(completed);
      expect(snapshot.tools[0]).toMatchObject({ state: 'running', output: '' });
      expect(completed.tools[0]).toMatchObject({ state: 'completed', output: 'Output' });
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });
  it('shares one detached event clone between read-only registry observers', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const first: SessionEvent[] = []; const second: SessionEvent[] = [];
    f.registry.subscribe(b.sessionId, event => { if ('change' in event) first.push(event); });
    f.registry.subscribe(b.sessionId, event => { if ('change' in event) second.push(event); });
    const change = { type: 'metadata.updated' as const, title: 'Before', state: 'open' as const, residency: 'warm' as const };
    const projection = f.registry.projection(b.sessionId); projection.publish(change);
    expect(first[0]).toBe(second[0]);
    expect(first[0]!.change).not.toBe(change);
    change.title = 'After'; projection.publish(change);
    expect(first[0]!.change).toMatchObject({ title: 'Before' });
    expect(first[1]).toBe(second[1]);
    expect(first[1]).not.toBe(first[0]);
    expect(first[1]!.change).toMatchObject({ title: 'After' });
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
  it('maps actual Pi entries and coalesces live-only tool output', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const runtime = f.instances.get(b.sessionId)!;
    const events: SessionEvent[] = [];
    f.registry.subscribe(b.sessionId, event => {
      if ('rev' in event) { expect(f.store.session(b.sessionId).revision).toBe(event.rev); events.push(event); }
    });
    const project = vi.spyOn(f.store, 'project'); const update = vi.spyOn(f.store, 'updateSession');
    runtime.emit({ type: 'tool_execution_start', toolCallId: 't', toolName: 'read', args: {} });
    for (let n = 0; n < 30; n++) runtime.emit({ type: 'tool_execution_update', toolCallId: 't', toolName: 'read', args: {}, partialResult: { content: [{ type: 'text', text: `out${n}` }], details: {} } });
    runtime.emit({ type: 'tool_execution_end', toolCallId: 't', toolName: 'read', result: { content: [{ type: 'text', text: 'tool-only output' }], details: {} }, isError: false });
    f.registry.projection(b.sessionId).refresh();
    expect(events.filter(e => e.change.type === 'tool.updated')).toHaveLength(1);
    expect(project).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
    expect(f.registry.projection(b.sessionId).snapshot().tools[0]).toMatchObject({ state: 'completed', output: 'tool-only output' });
    expect(JSON.stringify(readControlDatabase(f.store.directory))).not.toContain('tool-only output');
    project.mockRestore(); update.mockRestore();
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

  it.each(['text_delta', 'thinking_delta'] as const)('holds split surrogate pairs in %s until their code point is complete', async type => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const runtime = f.instances.get(b.sessionId)!; const projection = f.registry.projection(b.sessionId);
    const deltas: TextStreamEvent[] = [];
    f.registry.subscribe(b.sessionId, event => { if ('stream' in event) { expect(() => encodeFrame(event)).not.toThrow(); deltas.push(event); } });
    const chunks = ['A\ud83d', '', '\ude00B', '\ud83d', '\ude03'];
    const message = assistant(chunks.join('')); runtime.emit({ type: 'message_start', message });
    for (const delta of chunks) {
      runtime.emit({ type: 'message_update', message, assistantMessageEvent: { type, contentIndex: 0, delta, partial: message } });
      const snapshot = projection.snapshot();
      expect(parseSessionSnapshot(snapshot)).toEqual(snapshot);
      const stream = snapshot.activeStreams[0]!;
      expect(stream.offset).toBe(codePointLength(stream.text));
      expect(stream.text).toBe(deltas.map(event => event.text).join(''));
    }
    expect(deltas.map(event => event.text)).toEqual(['A', '😀B', '😃']);
    expect(deltas.map(event => event.stream.offset)).toEqual([0, 1, 3]);
    expect(deltas.map(event => event.text).join('')).toBe(chunks.join(''));
  });

  it('discards a withheld high surrogate when the completed message replaces its stream', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const runtime = f.instances.get(b.sessionId)!; const projection = f.registry.projection(b.sessionId);
    const events: Array<SessionEvent | TextStreamEvent> = [];
    f.registry.subscribe(b.sessionId, event => { expect(() => encodeFrame(event)).not.toThrow(); events.push(event); });
    const message = assistant('Authoritative completion'); runtime.emit({ type: 'message_start', message });
    runtime.emit({ type: 'message_update', message,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Prefix\ud83d', partial: message } });
    expect(projection.snapshot().activeStreams[0]).toMatchObject({ text: 'Prefix', offset: 6 });
    runtime.emit({ type: 'message_end', message });
    expect(parseSessionSnapshot(projection.snapshot()).activeStreams[0]).toMatchObject({ text: 'Prefix', offset: 6 });
    b.runtime.session.sessionManager.appendMessage(message); projection.refresh();
    const snapshot = projection.snapshot();
    expect(parseSessionSnapshot(snapshot)).toEqual(snapshot);
    expect(snapshot.activeStreams).toEqual([]);
    expect(snapshot.history.entries.at(-1)?.content).toEqual([{ type: 'text', text: 'Authoritative completion' }]);
    expect(events.filter(event => 'stream' in event).map(event => event.text)).toEqual(['Prefix']);
    expect(events.some(event => 'change' in event && event.change.type === 'message.completed')).toBe(true);
  });

  it.each([
    { type: 'text_delta', label: 'lone low surrogate', text: '\udc00' },
    { type: 'text_delta', label: 'unpaired high surrogate inside text', text: 'a\ud800b' },
    { type: 'thinking_delta', label: 'lone low surrogate', text: '\udc00' },
    { type: 'thinking_delta', label: 'unpaired high surrogate inside text', text: 'a\ud800b' },
  ] as const)('makes $type with a $label completion-only without fencing other sessions', async ({ type, text }) => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const other = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const runtime = f.instances.get(b.sessionId)!; const otherRuntime = f.instances.get(other.sessionId)!;
    const projection = f.registry.projection(b.sessionId); const otherProjection = f.registry.projection(other.sessionId);
    const events: Array<SessionEvent | TextStreamEvent> = [];
    f.registry.subscribe(b.sessionId, event => { events.push(event); });
    const message = assistant('Authoritative completion'); const otherMessage = assistant('Other session');
    runtime.emit({ type: 'message_start', message }); otherRuntime.emit({ type: 'message_start', message: otherMessage });
    const delta = (contentIndex: number, value: string) => runtime.emit({ type: 'message_update', message,
      assistantMessageEvent: { type, contentIndex, delta: value, partial: message } });
    delta(0, 'Retained prefix');
    delta(0, text);
    expect(() => f.registry.assertAdmission()).not.toThrow();
    expect(runtime.dispose).not.toHaveBeenCalled(); expect(otherRuntime.dispose).not.toHaveBeenCalled();
    const snapshot = projection.snapshot();
    expect(parseSessionSnapshot(snapshot)).toEqual(snapshot);
    expect(snapshot.activeStreams).toEqual([]);
    expect(snapshot.completionOnlyStreams).toEqual([{ id: expect.any(String), message: expect.any(String),
      kind: type === 'text_delta' ? 'assistant' : 'thinking', reason: 'lost' }]);
    expect(events.filter(event => 'change' in event && event.change.type === 'stream.completion_only')).toHaveLength(1);
    const eventCount = events.length;
    delta(0, 'Ignored later delta'); projection.refresh();
    expect(events).toHaveLength(eventCount);
    const prefix = 'x'.repeat(LIMITS.activeStreamBytes);
    for (let index = 1; index <= LIMITS.activeStreamsBytes / LIMITS.activeStreamBytes; index++) delta(index, prefix);
    expect(projection.snapshot().activeStreams).toHaveLength(4);
    expect(projection.snapshot().completionOnlyStreams).toEqual(snapshot.completionOnlyStreams);
    otherRuntime.emit({ type: 'message_update', message: otherMessage,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Unaffected', partial: otherMessage } });
    expect(otherProjection.snapshot().activeStreams[0]?.text).toBe('Unaffected');
    runtime.emit({ type: 'message_end', message }); b.runtime.session.sessionManager.appendMessage(message); projection.refresh();
    const completed = projection.snapshot();
    expect(completed.activeStreams).toEqual([]); expect(completed.completionOnlyStreams).toEqual([]);
    expect(events.some(event => 'change' in event && event.change.type === 'message.completed'
      && event.change.message.content.some(part => part.type === 'text' && part.text === 'Authoritative completion'))).toBe(true);
    for (const event of events) expect(() => encodeFrame(event)).not.toThrow();
    expect(() => f.registry.assertAdmission()).not.toThrow();
  });

  it('counts a split surrogate pair once at both stream byte limits', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const runtime = f.instances.get(b.sessionId)!; const projection = f.registry.projection(b.sessionId);
    const message = assistant('Pending'); runtime.emit({ type: 'message_start', message });
    const delta = (contentIndex: number, text: string) => runtime.emit({ type: 'message_update', message,
      assistantMessageEvent: { type: 'text_delta', contentIndex, delta: text, partial: message } });
    for (let index = 0; index < 3; index++) delta(index, 'x'.repeat(LIMITS.activeStreamBytes));
    delta(3, 'x'.repeat(LIMITS.activeStreamBytes - 4) + '\ud83d');
    delta(3, '\ude00');
    const snapshot = projection.snapshot();
    expect(parseSessionSnapshot(snapshot)).toEqual(snapshot);
    expect(snapshot.activeStreams).toHaveLength(4);
    expect(snapshot.completionOnlyStreams).toEqual([]);
    expect(snapshot.activeStreams[3]?.offset).toBe(LIMITS.activeStreamBytes - 3);
    delta(3, 'x');
    expect(projection.snapshot().completionOnlyStreams).toHaveLength(1);
    delta(4, 'x'.repeat(LIMITS.activeStreamBytes));
    expect(projection.snapshot().activeStreams).toHaveLength(4);
  });

  it('enforces UTF-8 stream limits and releases the bytes of completed messages', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const runtime = f.instances.get(b.sessionId)!; const projection = f.registry.projection(b.sessionId);
    const message = assistant('done'); runtime.emit({ type: 'message_start', message });
    const delta = (index: number, text: string) => runtime.emit({ type: 'message_update', message,
      assistantMessageEvent: { type: 'text_delta', contentIndex: index, delta: text, partial: message } });
    const prefix = '😀'.repeat(LIMITS.activeStreamBytes / 4);
    for (let index = 0; index < LIMITS.activeStreamsBytes / LIMITS.activeStreamBytes; index++) delta(index, prefix);
    let snapshot = projection.snapshot();
    expect(snapshot.activeStreams).toHaveLength(4);
    expect(snapshot.activeStreams.every(stream => stream.offset === prefix.length / 2)).toBe(true);
    delta(0, 'x');
    delta(4, prefix);
    delta(5, 'x');
    snapshot = projection.snapshot();
    expect(snapshot.activeStreams.map(stream => stream.id.split(':').at(-1))).toEqual(['1', '2', '3', '4']);
    expect(snapshot.completionOnlyStreams.map(stream => stream.id.split(':').at(-1))).toEqual(['0', '5']);
    const before = snapshot.revision;
    delta(0, 'ignored'); delta(5, 'ignored');
    expect(projection.snapshot().revision).toBe(before);
    runtime.emit({ type: 'message_end', message }); b.runtime.session.sessionManager.appendMessage(message); projection.refresh();
    const next = assistant('next'); runtime.emit({ type: 'message_start', message: next });
    for (let index = 0; index < 4; index++) runtime.emit({ type: 'message_update', message: next,
      assistantMessageEvent: { type: 'text_delta', contentIndex: index, delta: prefix, partial: next } });
    snapshot = projection.snapshot();
    expect(snapshot.activeStreams).toHaveLength(4);
    expect(snapshot.completionOnlyStreams).toEqual([]);
  });

  it('counts completion-only streams toward the active stream capacity', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    f.registry.projection(b.sessionId).dispose();
    const errors: unknown[] = [];
    const projection = new SessionProjection({ binding: b, store: f.store, extras: () => ({ children: [], processes: [], interactions: [] }),
      publish() {}, onError: error => errors.push(error) });
    try {
      const runtime = f.instances.get(b.sessionId)!; const message = assistant(); runtime.emit({ type: 'message_start', message });
      for (let index = 0; index < LIMITS.activeStreams; index++) runtime.emit({ type: 'message_update', message,
        assistantMessageEvent: { type: 'text_delta', contentIndex: index, delta: index ? '' : 'x'.repeat(LIMITS.activeStreamBytes + 1), partial: message } });
      expect(projection.snapshot().activeStreams).toHaveLength(LIMITS.activeStreams - 1);
      expect(projection.snapshot().completionOnlyStreams).toHaveLength(1);
      expect(errors).toEqual([]);
      runtime.emit({ type: 'message_update', message,
        assistantMessageEvent: { type: 'text_delta', contentIndex: LIMITS.activeStreams, delta: 'x', partial: message } });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ message: 'Active stream capacity exceeded.' });
    } finally { projection.dispose(); }
  });

  it('publishes the prompt cursor before the first response delta so a delayed refresh cannot clear it', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const runtime = f.instances.get(b.sessionId)!; const projection = f.registry.projection(b.sessionId);
    const events: Array<SessionEvent | TextStreamEvent> = [];
    f.registry.subscribe(b.sessionId, event => { if ('rev' in event || 'stream' in event) events.push(event); });
    b.runtime.session.sessionManager.appendMessage({ role: 'user', content: 'Start streaming', timestamp: 0 });
    const message = assistant('First delta');
    runtime.emit({ type: 'message_start', message });
    runtime.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'First delta', partial: message } });
    projection.refresh();
    const cursor = events.findIndex(event => 'change' in event && event.change.type === 'branch.updated');
    const delta = events.findIndex(event => 'stream' in event);
    expect(cursor).toBeGreaterThanOrEqual(0);
    expect(delta).toBeGreaterThan(cursor);
    expect(events.slice(delta + 1).some(event => 'change' in event && event.change.type === 'branch.updated')).toBe(false);
    expect(projection.snapshot().activeStreams[0]?.text).toBe('First delta');
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
  it('projects newly appended entries after branch navigation and compaction exactly once', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const manager = b.runtime.session.sessionManager; const projection = f.registry.projection(b.sessionId);
    const events: SessionEvent[] = []; f.registry.subscribe(b.sessionId, event => { if ('change' in event) events.push(event); });
    const first = manager.appendMessage({ role: 'user', content: 'First', timestamp: 0 });
    const second = manager.appendMessage(assistant('Second')); projection.refresh();
    manager.branch(first);
    const branch = manager.appendMessage(assistant('Another branch')); projection.refresh();
    const compact = manager.appendCompaction('Retained summary', first, 1024); projection.refresh();
    const after = manager.appendMessage({ role: 'user', content: 'After compaction', timestamp: 0 }); projection.refresh();
    manager.branch(second); projection.refresh(); projection.refresh();
    expect(events.flatMap(event => event.change.type === 'message.completed' ? [event.change.message.entryId] : [])).toEqual([first, second, branch, compact, after]);
    expect(projection.snapshot().history.entries.map(entry => entry.entryId)).toEqual([first, second]);
  });
  it('skips scanned entry ids until the entry list shrinks or the checkpoint changes', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const manager = b.runtime.session.sessionManager; const projection = f.registry.projection(b.sessionId);
    manager.appendMessage({ role: 'user', content: 'First', timestamp: 0 });
    manager.appendMessage(assistant('Second')); projection.refresh();
    const entries = manager.getEntries(); let idReads = 0;
    const first = new Proxy(entries[0]!, { get(target, key, receiver) { if (key === 'id') idReads++; return Reflect.get(target, key, receiver); } });
    const getEntries = vi.spyOn(manager, 'getEntries').mockReturnValue([first, ...entries.slice(1)]);
    const events: SessionEvent[] = []; f.registry.subscribe(b.sessionId, event => { if ('change' in event) events.push(event); });
    try {
      projection.refresh(); expect(idReads).toBe(0);
      manager.appendMessage(assistant('Appended'));
      const appended = manager.getLeafEntry()!;
      getEntries.mockReturnValue([first, ...entries.slice(1), appended]);
      projection.refresh(); expect(idReads).toBe(0);
      manager.appendMessage(assistant('After shrink'));
      const shrunk = manager.getLeafEntry()!;
      getEntries.mockReturnValue([first, shrunk]);
      projection.refresh(); expect(idReads).toBeGreaterThan(0);
      manager.appendMessage(assistant('Replaced checkpoint'));
      const replaced = manager.getLeafEntry()!;
      getEntries.mockReturnValue([first, replaced]);
      projection.refresh();
      expect(events.flatMap(event => event.change.type === 'message.completed' ? [event.change.message.entryId] : [])).toEqual([appended.id, shrunk.id, replaced.id]);
    } finally { getEntries.mockRestore(); }
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

});
