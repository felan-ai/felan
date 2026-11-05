import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS, encodeFrame, parseOperationResult, parseSessionSnapshot, type Message, type SessionSnapshot } from '@felan-ai/session-protocol';
import { boundSnapshot, encodeHistoryCursor, SNAPSHOT_BYTE_BUDGET } from '../src/daemon/snapshot-bounds.js';
import { fixture, fixtures, supported } from './fixtures/registry.js';

afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const message = (index: number, text = 'message'): Message => ({ id: `message-${index}`, entryId: `entry-${index}`,
  role: 'assistant', content: [{ type: 'text', text }], timestamp: index });
const tool = (id: string, output = '', state: SessionSnapshot['tools'][number]['state'] = 'completed'): SessionSnapshot['tools'][number] => ({
  id, name: 'read', message: 'pending', state, output, truncated: false,
});

function snapshot(): SessionSnapshot {
  return {
    session: 'session', root: 'session', parent: 'parent', revision: 7, cwd: '/fixture', title: 'Test', state: 'open', residency: 'warm',
    branch: 'branch', history: { revision: 7, branch: 'branch', entries: [] }, model: { provider: 'fixture', id: 'model' }, thinking: 'off',
    queue: [{ id: 'queued', kind: 'follow_up', prompt: { text: 'Keep working' }, origin: { kind: 'tui', attachment: 'attachment' } }],
    run: { state: 'running', id: 'run' }, policy: { effective: 'host-default', generation: 0 },
    catalog: { tools: [], commands: [], models: [{ provider: 'fixture', id: 'model', label: 'Model', thinking: ['off'] }] },
    interactions: [{ id: 'question', scope: { kind: 'session', session: 'session', root: 'session' },
      request: { kind: 'confirm', title: 'Continue?', message: 'Confirm' }, createdAt: 0, state: 'waiting' }],
    children: [{ session: 'child', parent: 'session', root: 'session', title: 'Child', state: 'open', run: { state: 'running', id: 'child-run' } }],
    processes: [{ id: 'process', session: 'session', root: 'session', kind: 'pty', state: 'running', command: 'echo test',
      startedAt: 0, controllable: true, outputOffset: 0 }],
    tools: [], presentation: [{ id: 'notice', kind: 'notification', level: 'info', text: 'Working' }],
    activeStreams: [{ id: 'active', message: 'pending', kind: 'assistant', text: 'a😀', offset: 2 }],
    completionOnlyStreams: [{ id: 'omitted', message: 'pending', kind: 'thinking', reason: 'limit' }], executionsGeneration: 'a'.repeat(64),
  };
}

function expectValid(value: SessionSnapshot, budget: number): void {
  expect(bytes(value)).toBeLessThanOrEqual(budget);
  expect(parseSessionSnapshot(value)).toEqual(value);
}

describe('snapshot byte bounds', () => {
  it('returns a fitting snapshot unchanged, including the exact boundary', () => {
    const original = snapshot();
    expectValid(original, SNAPSHOT_BYTE_BUDGET);
    expect(boundSnapshot(original)).toBe(original);
    expect(boundSnapshot(original, bytes(original))).toBe(original);
  });

  it('trims the oldest completed output before newer output or history without mutating the input', () => {
    const original = snapshot();
    original.tools = [tool('z-oldest', 'old'.repeat(100)), tool('running', 'keep running', 'running'), tool('a-newest', 'keep completed')];
    original.history.entries = [message(0)];
    const copy = structuredClone(original);
    const expected = { ...original, tools: [{ ...original.tools[0]!, output: 'old'.repeat(20), truncated: true }, ...original.tools.slice(1)] };
    const result = boundSnapshot(original, bytes(expected));
    expectValid(result, bytes(expected));
    expect(result).toEqual(expected);
    expect(result.history).toBe(original.history);
    expect(result.tools.slice(1)).toEqual(original.tools.slice(1));
    expect(original).toEqual(copy);
    expect(boundSnapshot(original, bytes(expected))).toEqual(result);
    expect(boundSnapshot(result, bytes(expected))).toBe(result);
  });

  it('fits a large tool snapshot within six MiB and leaves room for the attach envelope and live state', () => {
    const original = snapshot();
    original.tools = Array.from({ length: LIMITS.pageEntries - 1 }, (_, index) => tool(`tool-${index}`, 'x'.repeat(LIMITS.statusTextBytes)));
    original.tools.splice(100, 0, tool('running', 'still working', 'running'));
    const result = boundSnapshot(original);
    expect(SNAPSHOT_BYTE_BUDGET).toBe(6 * 1024 * 1024);
    expect(bytes(original)).toBeGreaterThan(LIMITS.pageBytes);
    expectValid(result, SNAPSHOT_BYTE_BUDGET);
    expect(result.tools.map(item => item.id)).toEqual(original.tools.map(item => item.id));
    expect(result.tools[0]).toMatchObject({ output: '', truncated: true });
    expect(result.tools.at(-1)).toEqual(original.tools.at(-1));
    expect(result.tools[100]).toBe(original.tools[100]);
    const attach = { attachmentId: 'a'.repeat(LIMITS.idBytes), snapshot: result };
    expect(parseOperationResult('attach', attach)).toEqual(attach);
    const envelope = { v: 1, re: 'r'.repeat(LIMITS.idBytes), outcome: 'accepted', result: attach };
    expect(() => encodeFrame(envelope)).not.toThrow();
    expect(bytes(envelope)).toBeLessThan(LIMITS.pageBytes);
    expect(LIMITS.pageBytes - bytes(result)).toBeGreaterThanOrEqual(SNAPSHOT_BYTE_BUDGET);
  });

  it('accounts for JSON escaping and UTF-8 without splitting a surrogate pair', () => {
    const original = snapshot();
    original.tools = [tool('escaped', '\u0000\\"😀é\n'.repeat(100))];
    const empty = { ...original, tools: [{ ...original.tools[0]!, output: '', truncated: true }] };
    for (let available = 0; available <= 36; available++) {
      const budget = bytes(empty) + available;
      const result = boundSnapshot(original, budget);
      expectValid(result, budget);
      const output = result.tools[0]!.output;
      expect(original.tools[0]!.output.startsWith(output)).toBe(true);
      expect(Buffer.from(output).toString('utf8')).toBe(output);
      expect(result.tools[0]!.truncated).toBe(true);
    }
  });

  it.each(['completed', 'failed', 'interrupted'] as const)('trims %s output before removing history', state => {
    const original = snapshot();
    original.tools = [tool('finished', 'x'.repeat(100), state)];
    original.history.entries = [message(0, 'history')];
    const expected = { ...original, tools: [{ ...original.tools[0]!, output: '', truncated: true }] };
    const result = boundSnapshot(original, bytes(expected));
    expectValid(result, bytes(expected));
    expect(result).toEqual(expected);
  });

  it.each([0, 7])('shortens history from the oldest end with an existing cursor offset of %i', start => {
    const original = snapshot();
    original.history.entries = Array.from({ length: 4 }, (_, index) => message(index, 'x'.repeat(1024)));
    if (start) original.history.cursor = encodeHistoryCursor(original.session, original.revision, original.branch, start);
    const expected = { ...original, history: { ...original.history, entries: original.history.entries.slice(2),
      cursor: encodeHistoryCursor(original.session, original.revision, original.branch, start + 2) } };
    const result = boundSnapshot(original, bytes(expected));
    expectValid(result, bytes(expected));
    expect(result).toEqual(expected);
    expect(JSON.parse(Buffer.from(result.history.cursor!, 'base64url').toString('utf8'))).toEqual(['session', 7, 'branch', start + 2]);
    expect(original.history.entries).toHaveLength(4);
  });

  it('can page all history away while retaining a cursor and all live state', () => {
    const original = snapshot();
    original.history.entries = [message(0, 'x'.repeat(2048))];
    const expected = { ...original, history: { ...original.history, entries: [], cursor: encodeHistoryCursor('session', 7, 'branch', 1) } };
    const result = boundSnapshot(original, bytes(expected));
    expectValid(result, bytes(expected));
    expect(result).toEqual(expected);
    for (const key of ['activeStreams', 'completionOnlyStreams', 'queue', 'interactions', 'run', 'model', 'policy', 'catalog',
      'children', 'processes', 'presentation'] as const) expect(result[key]).toBe(original[key]);
  });

  it('only drops completed tool states after trimming output and history, preserving tool order', () => {
    const original = snapshot();
    original.tools = [{ ...tool('z-oldest', 'old output'), details: { text: 'x'.repeat(2048) } }, tool('running', 'keep me', 'running'),
      { ...tool('a-newest', 'new output'), details: { text: 'y'.repeat(2048) } }];
    original.history.entries = [message(0, 'x'.repeat(2048))];
    const expected = { ...original, tools: [original.tools[1]!, { ...original.tools[2]!, output: '', truncated: true }],
      history: { ...original.history, entries: [], cursor: encodeHistoryCursor('session', 7, 'branch', 1) } };
    const result = boundSnapshot(original, bytes(expected));
    expectValid(result, bytes(expected));
    expect(result).toEqual(expected);
    expect(result.tools[0]).toBe(original.tools[1]);
    expect(original.tools[0]!.output).toBe('old output');
  });

  it('returns valid protected state even when it alone exceeds the budget', () => {
    const original = snapshot();
    original.tools = [tool('running', 'x'.repeat(1024), 'running')];
    const copy = structuredClone(original);
    const result = boundSnapshot(original, bytes(original) - 1);
    expect(parseSessionSnapshot(result)).toEqual(copy);
    expect(original).toEqual(copy);
  });

  it('removes all optional history and completed tools before returning oversized protected state', () => {
    const original = snapshot();
    original.tools = [tool('completed', 'discard me'), tool('running', 'x'.repeat(1024), 'running')];
    original.history.entries = [message(0, 'discard me')];
    const copy = structuredClone(original);
    const expected = { ...original, tools: [original.tools[1]!], history: { ...original.history, entries: [],
      cursor: encodeHistoryCursor(original.session, original.revision, original.branch, 1) } };
    const result = boundSnapshot(original, bytes(expected) - 1);
    expect(bytes(result)).toBeGreaterThan(bytes(expected) - 1);
    expect(parseSessionSnapshot(result)).toEqual(expected);
    expect(original).toEqual(copy);
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid budget of %s', budget => {
    expect(() => boundSnapshot(snapshot(), budget)).toThrow('Invalid snapshot byte budget.');
  });

  it.each(['invalid', Buffer.from(JSON.stringify(['other', 7, 'branch', 1])).toString('base64url')])('rejects an unusable cursor before discarding history', cursor => {
    const original = snapshot();
    original.history = { ...original.history, entries: [message(0, 'x'.repeat(1024))], cursor };
    expect(() => boundSnapshot(original, bytes(original) - 100)).toThrow('Invalid snapshot history cursor.');
  });
});

it.runIf(supported)('produces a cursor accepted by SessionProjection.history without gaps or duplicates', async () => {
  const f = await fixture();
  const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  for (let index = 0; index < 8; index++) binding.runtime.session.sessionManager.appendMessage({ role: 'user', content: 'x'.repeat(1024), timestamp: index });
  const projection = f.registry.projection(binding.sessionId);
  const original = projection.snapshot();
  original.history = projection.history(undefined, original.revision, 4);
  const previousEnd = JSON.parse(Buffer.from(original.history.cursor!, 'base64url').toString('utf8'))[3] as number;
  const expected = { ...original, history: { ...original.history, entries: original.history.entries.slice(2),
    cursor: encodeHistoryCursor(original.session, original.revision, original.branch, previousEnd + 2) } };
  const result = boundSnapshot(original, bytes(expected));
  expectValid(result, bytes(expected));
  expect(result).toEqual(expected);
  const older = projection.history(result.history.cursor, result.revision);
  expect(parseOperationResult('session.history', older)).toEqual(older);
  const all = [...older.entries, ...result.history.entries].map(entry => entry.entryId);
  expect(all).toEqual(binding.runtime.session.sessionManager.getBranch().map(entry => entry.id));
  expect(new Set(all).size).toBe(8);
});
