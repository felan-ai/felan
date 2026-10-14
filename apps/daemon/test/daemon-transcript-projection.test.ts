import { afterEach, expect, it, vi } from 'vitest';
import type { SessionEntry } from '@felan-ai/agent-core';
import { convertToLlm } from '@earendil-works/pi-coding-agent';
import { MESSAGE_DISPLAY_ID, type ClientEnvelope } from '@felan-ai/session-protocol';
import { SessionCommands } from '../src/daemon/commands.js';
import type { AdmittedCommand } from '../src/daemon/admission.js';
import type { HostConfiguration } from '../src/daemon/host-services.js';
import { projectPiMessage } from '../src/daemon/projection.js';
import { assistant, fixture, fixtures, requestId, supported } from './fixtures/registry.js';
import { serverFixture } from './fixtures/server.js';

afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });

it.each([false, true])('projects shell output, exit status and excluded=%s without losing native context semantics', excludeFromContext => {
  const entry: Extract<SessionEntry, { type: 'message' }> = { id: 'shell', type: 'message', parentId: null, timestamp: new Date(0).toISOString(),
    message: { role: 'bashExecution', command: 'echo hi', output: 'hi\n', exitCode: 3, cancelled: false, truncated: true,
      fullOutputPath: '/fixture/output', excludeFromContext, timestamp: 0 } };
  expect(projectPiMessage(entry)).toMatchObject({ role: 'custom', customType: 'bashExecution', content: [{ type: 'text', text: 'hi\n' }],
    details: { command: 'echo hi', exitCode: 3, cancelled: false, truncated: true, fullOutputPath: '/fixture/output', excludeFromContext } });
});

it.skipIf(!supported)('recovers live metadata after an incomplete initial assistant frame without changing thinking kind', async () => {
  const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  const projection = f.registry.projection(binding.sessionId); const runtime = f.instances.get(binding.sessionId)!;
  const message = assistant();
  runtime.emit({ type: 'message_start', message: { ...message, usage: undefined } as never });
  expect(projection.snapshot().presentation.some(item => item.id === MESSAGE_DISPLAY_ID)).toBe(false);
  runtime.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Partial thought', partial: message } });
  const state = projection.snapshot();
  expect(state.activeStreams).toEqual([expect.objectContaining({ kind: 'thinking', text: 'Partial thought' })]);
  expect(state.presentation).toContainEqual(expect.objectContaining({ id: MESSAGE_DISPLAY_ID,
    data: expect.objectContaining({ display: expect.objectContaining({ model: 'fixture' }) }) }));
});

it.skipIf(!supported).each([false, true])('streams shell output and retains a single result (includeInContext=%s)', async includeInContext => {
  const f = await serverFixture(); fixtures.push(() => f.dispose());
  const session = f.root.sessionId; const command = 'printf first; sleep 0.2; printf last; exit 7';
  const request: ClientEnvelope = { v: 1, id: requestId(), op: 'shell.execute', session, params: { command, includeInContext } };
  f.store.admit(request, 'owner');
  const dispatcher = new SessionCommands({ registry: f.registry, configuration: {} as HostConfiguration,
    models: { getAvailable: async () => [] }, invalidated() {} });
  const result = await dispatcher.prepare({ request } as AdmittedCommand, { origin: { kind: 'tui', attachment: 'fixture' } });
  await expect(result.response).resolves.toMatchObject({ outcome: 'accepted', result: { resourceId: expect.any(String) } });
  const projection = f.registry.projection(session);
  await vi.waitFor(() => expect(projection.snapshot().presentation).toContainEqual(expect.objectContaining({ kind: 'document',
    hint: { id: 'shell.execution', version: '1.0.0' }, markdown: `\`\`\`\n$ ${command}\nfirst\n\`\`\``,
    data: { commandLength: command.length, excludeFromContext: !includeInContext } })), { interval: 10 });
  await vi.waitFor(() => expect(projection.snapshot().history.entries.filter(item => item.customType === 'bashExecution')).toHaveLength(1));
  const final = projection.snapshot();
  expect(final.presentation.some(item => item.kind === 'document' && item.hint?.id === 'shell.execution')).toBe(false);
  expect(final.history.entries.at(-1)).toMatchObject({ content: [{ type: 'text', text: 'firstlast' }], details: { command, exitCode: 7, excludeFromContext: !includeInContext } });
  expect(f.root.runtime.session.messages.at(-1)).toMatchObject({ role: 'bashExecution', output: 'firstlast', exitCode: 7, excludeFromContext: !includeInContext });
  expect(convertToLlm([f.root.runtime.session.messages.at(-1)!])).toHaveLength(includeInContext ? 1 : 0);
});
