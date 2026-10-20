import { expect, it, vi } from 'vitest';
import { MESSAGE_DISPLAY_KEY, MESSAGE_DISPLAY_ID, PresentationSchema, parseActiveMessageDisplay, parseMessageDisplay, parseOperationResult, parseSchema, readMessageDisplay } from '../src/index.js';

const display = { kind: 'assistant', timestamp: 42, api: 'fixture-api', provider: 'fixture', model: 'model', stopReason: 'toolUse',
  usage: { input: 17, output: 23, cacheRead: 2, cacheWrite: 3, totalTokens: 45, cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 } } };
it('carries actual assistant fields inside existing JSON presentation and message details', () => {
  expect(readMessageDisplay({ [MESSAGE_DISPLAY_KEY]: display })).toEqual(display);
  const active = { message: 'assistant', display };
  expect(parseSchema(PresentationSchema, { id: MESSAGE_DISPLAY_ID, kind: 'message_display', data: active })).toMatchObject({ data: active });
  expect(parseActiveMessageDisplay(active)).toEqual(active);
  expect(parseMessageDisplay({ kind: 'tool', name: 'read', timestamp: 7 })).toEqual({ kind: 'tool', name: 'read', timestamp: 7 });
  expect(readMessageDisplay({ other: 'legacy details' })).toBeUndefined();
});
it('rejects unknown, oversized, non-finite and incomplete display data without defaults', () => {
  for (const [label, invalid] of [
    ['unknown root field', { ...display, extra: 'unknown' }],
    ['unknown usage field', { ...display, usage: { ...display.usage, extra: 1 } }],
    ['unknown cost field', { ...display, usage: { ...display.usage, cost: { ...display.usage.cost, extra: 1 } } }],
    ['oversized model', { ...display, model: 'x'.repeat(257) }],
    ['incomplete usage', { ...display, usage: {} }],
    ['negative usage', { ...display, usage: { ...display.usage, input: -1 } }],
    ['non-finite cost', { ...display, usage: { ...display.usage, cost: { ...display.usage.cost, total: Infinity } } }],
    ['unknown stop reason', { ...display, stopReason: 'invented' }],
    ['unknown tool field', { kind: 'tool', name: 'read', timestamp: 7, extra: 1 }],
  ] as const) expect(() => parseMessageDisplay(invalid), label).toThrow();
  expect(() => parseActiveMessageDisplay({ message: 'id', display, extra: 1 })).toThrow();
  expect(() => parseActiveMessageDisplay({ message: 'id', display: { kind: 'tool', name: 'read', timestamp: 7 } })).toThrow();
  expect(() => readMessageDisplay({ [MESSAGE_DISPLAY_KEY]: null })).toThrow();
  const getter = vi.fn(() => display);
  expect(() => readMessageDisplay(Object.defineProperty({}, MESSAGE_DISPLAY_KEY, { get: getter }))).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

it('parses session tree display facts and rejects unknown stop reasons', () => {
  const page = { revision: 1, branch: 'reply', entries: [
    { id: 'reply', parent: 'prompt', kind: 'message', role: 'assistant', summary: '', timestamp: 2, labelTimestamp: 3, title: 'read: a.ts', stopReason: 'error', errorMessage: 'boom' },
  ] };
  expect(parseOperationResult('session.tree', page)).toEqual(page);
  expect(() => parseOperationResult('session.tree', { ...page, entries: [{ ...page.entries[0], stopReason: 'unknown' }] })).toThrow();
});
