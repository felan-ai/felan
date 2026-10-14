import { expect, it } from 'vitest';
import type { AgentSessionEvent } from '@felan-ai/agent-core';
import { headlessJsonEvent } from '../src/daemon/headless-json.js';
import { assistant } from './fixtures/registry.js';

it('matches print-mode tool start and delta shape without serializing the changing partial message', () => {
  const partial = { ...assistant(), content: [{ type: 'toolCall' as const, id: 'call', name: 'read', arguments: {} }] };
  const event = { type: 'message_update', message: partial, assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial } } as AgentSessionEvent;
  expect(headlessJsonEvent(event)).toEqual({ type: 'message_update', usage: partial.usage,
    assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'call', toolName: 'read' } });
});
