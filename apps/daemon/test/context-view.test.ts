import { expect, it, vi } from 'vitest';
import type { ContextReport } from '@felan-ai/ext-context-view';
import type { Interaction } from '@felan-ai/session-protocol';
import { parseContextViewRequest } from '@felan-ai/ext-context-view/view';
import { createBrokerContextViewHost } from '../src/daemon/context-view.js';

const report: ContextReport = { breakdown: { systemPrompt: 0, systemTools: 0, extensions: 0, contextFiles: 0, skills: 0, memory: 0, messages: 0, other: 0, available: 0 },
  usedTokens: 0, contextWindow: null, usagePercent: null, estimated: true, systemToolCount: 0, extensionToolCount: 0, contextFileCount: 0, skillCount: 0,
  memory: { summary: 0, index: 0, schema: 0, recalls: 0 }, extensionDetails: [], skillDetails: [], modelLabel: null };

it('uses a bounded custom interaction and reports unsupported presentation', async () => {
  const request = vi.fn(async (_value: Interaction['request'], _dialog: { signal: AbortSignal }) => ({ state: 'cancelled' as const, reason: 'unsupported' as const }));
  const host = createBrokerContextViewHost({ signal: new AbortController().signal, request, unsupported(surface) { throw new Error(`unsupported ${surface}`); } });
  await expect(host.show({ custom: vi.fn() }, report, 'overlay', new AbortController().signal)).rejects.toThrow('unsupported context view');
  const value = request.mock.calls[0]![0];
  expect(value.kind).toBe('custom'); if (value.kind !== 'custom') throw new Error();
  expect(parseContextViewRequest(value.data)).toMatchObject({ displayMode: 'overlay', report: { contextWindow: null } });
});

it('does not request UI after cancellation', async () => {
  const control = new AbortController(); control.abort(); const request = vi.fn();
  const host = createBrokerContextViewHost({ signal: control.signal, request, unsupported() { throw new Error(); } });
  await host.show({ custom: vi.fn() }, report, 'inline', new AbortController().signal);
  expect(request).not.toHaveBeenCalled();
});
