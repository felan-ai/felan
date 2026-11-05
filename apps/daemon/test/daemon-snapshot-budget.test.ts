import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { LIMITS, encodeFrame, parseOperationResult, parseSessionSnapshot, type SessionSnapshot } from '@felan-ai/session-protocol';
import { SessionFanout } from '../src/daemon/fanout.js';
import { SNAPSHOT_BYTE_BUDGET } from '../src/daemon/snapshot-bounds.js';
import { assistant, fixture, fixtures, supported } from './fixtures/registry.js';

afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

it.runIf(supported)('bounds registry attachments, pages omitted history and replays held stream deltas', async () => {
  const f = await fixture();
  const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  const id = binding.sessionId; const runtime = f.instances.get(id)!;
  const projection = f.registry.projection(id); const manager = runtime.session.sessionManager;
  const diagnostic = vi.fn(); f.registry.options.onDiagnostic = diagnostic;
  for (let index = 0; index < 300; index++) manager.appendMessage({ role: 'user', content: 'h'.repeat(32 * 1024), timestamp: index });
  projection.refresh();
  const output = 'x'.repeat(LIMITS.statusTextBytes);
  for (let index = 0; index < LIMITS.pageEntries; index++) {
    const toolCallId = `tool-${index}`;
    runtime.emit({ type: 'tool_execution_start', toolCallId, toolName: 'read', args: {} });
    const result = { content: [{ type: 'text' as const, text: output }], details: {} };
    if (index < LIMITS.pageEntries - 1) runtime.emit({ type: 'tool_execution_end', toolCallId, toolName: 'read', result, isError: false });
    else runtime.emit({ type: 'tool_execution_update', toolCallId, toolName: 'read', args: {}, partialResult: result });
  }
  const message = assistant();
  runtime.emit({ type: 'message_start', message });
  const delta = (text: string) => runtime.emit({ type: 'message_update', message,
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text, partial: message } });
  delta('a😀');
  const attached = await f.registry.attach(id, { principal: 'fixture', kind: 'headless' });
  const snapshot = attached.snapshot;
  expect(bytes(snapshot)).toBeLessThanOrEqual(SNAPSHOT_BYTE_BUDGET);
  expect(parseSessionSnapshot(snapshot)).toEqual(snapshot);
  const result = { attachmentId: attached.attachment, snapshot };
  expect(parseOperationResult('attach', result)).toEqual(result);
  expect(() => encodeFrame({ v: 1, re: 'attach', outcome: 'accepted', result })).not.toThrow();
  expect(snapshot.tools).toHaveLength(LIMITS.pageEntries);
  expect(snapshot.tools.slice(0, -1).every(tool => tool.state === 'completed' && tool.output === '' && tool.truncated)).toBe(true);
  expect(snapshot.tools.at(-1)).toMatchObject({ state: 'running', output, truncated: false });
  expect(snapshot.activeStreams).toEqual([expect.objectContaining({ text: 'a😀', offset: 2 })]);
  const initialPage = projection.history(undefined, snapshot.revision);
  expect(snapshot.history.entries.length).toBeLessThan(initialPage.entries.length);
  expect(snapshot.history.cursor).not.toBe(initialPage.cursor);
  const entryIds = snapshot.history.entries.map(entry => entry.entryId);
  let cursor = snapshot.history.cursor;
  expect(cursor).toBeDefined();
  while (cursor) {
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).slice(0, 3)).toEqual([id, snapshot.revision, snapshot.branch]);
    const page = projection.history(cursor, snapshot.revision);
    expect(parseOperationResult('session.history', page)).toEqual(page);
    entryIds.unshift(...page.entries.map(entry => entry.entryId));
    cursor = page.cursor;
  }
  expect(entryIds).toEqual(manager.getBranch().map(entry => entry.id));
  expect(new Set(entryIds).size).toBe(300);

  const frames: unknown[] = []; const close = vi.fn();
  const fanout = new SessionFanout({ close, write(data, done) {
    frames.push(...Buffer.from(data).toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line)));
    done(); return true;
  } });
  try {
    let handoff: SessionSnapshot | undefined;
    const detach = fanout.attach({ subscribe: listener => f.registry.subscribe(id, listener), snapshot() {
      delta('b');
      const value = projection.snapshot();
      delta('c'); delta('😀');
      return value;
    } }, value => {
      handoff = value;
      expect(bytes(value)).toBeLessThanOrEqual(SNAPSHOT_BYTE_BUDGET);
      return { v: 1, re: 'resync', outcome: 'accepted', result: parseOperationResult('attach', { attachmentId: attached.attachment, snapshot: value }) };
    });
    await nextTurn();
    const stream = snapshot.activeStreams[0]!;
    expect(frames).toEqual([
      { v: 1, re: 'resync', outcome: 'accepted', result: { attachmentId: attached.attachment, snapshot: handoff } },
      { v: 1, session: id, stream: { id: stream.id, message: stream.message, kind: stream.kind, offset: 3 }, text: 'c😀' },
    ]);
    delta('d'); await nextTurn();
    expect(frames.at(-1)).toMatchObject({ session: id, stream: { offset: 5 }, text: 'd' });
    expect(fanout.pendingBytes).toBe(0);
    expect(close).not.toHaveBeenCalled();
    detach();
    expect(diagnostic).not.toHaveBeenCalled();
  } finally { fanout.close(); f.registry.detach(id, attached.attachment); }
}, 30_000);
