import { expect, it } from 'vitest';
import { MESSAGE_DISPLAY_KEY, MESSAGE_DISPLAY_ID, type Message, type SessionSnapshot } from '@felan-ai/session-protocol';
import { projectedNativeMessage, projectedStreamingMessage } from '../src/client/message-display.js';

const metadata = { kind: 'assistant' as const, timestamp: 43, api: 'fixture', provider: 'offline', model: 'actual-model', stopReason: 'toolUse' as const,
  usage: { input: 17, output: 23, cacheRead: 2, cacheWrite: 3, totalTokens: 45, cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 } } };
it('reconstructs native rendering messages from actual metadata without default model or usage', () => {
  const message: Message = { id: 'message', entryId: 'entry', role: 'assistant', timestamp: 99,
    content: [{ type: 'thinking', text: 'Reason' }, { type: 'tool_call', id: 'call', name: 'read', arguments: { path: 'a.ts' } }],
    details: { [MESSAGE_DISPLAY_KEY]: metadata } };
  expect(projectedNativeMessage(message)).toEqual({ role: 'assistant', ...Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'kind')),
    content: [{ type: 'thinking', thinking: 'Reason' }, { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'a.ts' } }] });
  const { details: _details, ...legacy } = message;
  expect(projectedNativeMessage(legacy)).toBeUndefined();
  expect(projectedNativeMessage(message)).toBe(projectedNativeMessage(message));
  expect(projectedNativeMessage(structuredClone(message))).not.toBe(projectedNativeMessage(message));
  const received = structuredClone(message); Object.freeze(received.content[1]); Object.freeze((received.content[1] as { arguments: object }).arguments);
  const call = projectedNativeMessage(received)?.content[1];
  expect(call).toMatchObject({ type: 'toolCall', arguments: { path: 'a.ts' } });
  expect(Object.isFrozen((call as { arguments: object }).arguments)).toBe(false);
});
it('retains tool identity and result details instead of deriving a name from text', () => {
  expect(projectedNativeMessage({ id: 'result', entryId: 'entry', timestamp: 99, role: 'tool',
    details: { [MESSAGE_DISPLAY_KEY]: { kind: 'tool', name: 'read', timestamp: 44 } },
    content: [{ type: 'tool_result', id: 'call', text: 'output', isError: false, details: { fixture: true } }] })).toEqual({
    role: 'toolResult', toolCallId: 'call', toolName: 'read', timestamp: 44, content: [{ type: 'text', text: 'output' }], isError: false, details: { fixture: true },
  });
});
it('joins ordered active prefixes with their own metadata and ignores completed or unknown streams', () => {
  const snapshot: Pick<SessionSnapshot, 'presentation' | 'activeStreams' | 'history'> = { history: { entries: [], branch: 'branch', revision: 0 },
    presentation: [{ id: MESSAGE_DISPLAY_ID, kind: 'message_display', data: { message: 'active', display: metadata } }],
    activeStreams: [{ id: 'active:1', message: 'active', kind: 'assistant', offset: 6, text: 'Answer' },
      { id: 'active:0', message: 'active', kind: 'thinking', offset: 6, text: 'Reason' }] };
  expect(projectedStreamingMessage(snapshot)).toMatchObject({ model: 'actual-model', timestamp: 43, usage: metadata.usage,
    content: [{ type: 'thinking', thinking: 'Reason' }, { type: 'text', text: 'Answer' }] });
  expect(projectedStreamingMessage({ ...snapshot, presentation: [] })).toBeUndefined();
  expect(projectedStreamingMessage({ ...snapshot, history: { ...snapshot.history, entries: [{ id: 'active', entryId: 'entry', role: 'assistant', timestamp: 1, content: [] }] } })).toBeUndefined();
});
