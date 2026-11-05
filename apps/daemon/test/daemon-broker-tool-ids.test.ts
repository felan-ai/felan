import { createAssistantMessageEventStream, type ExtensionAPI } from '@felan-ai/agent-core';
import { parseClientEnvelope, parseInteraction, type SessionEvent } from '@felan-ai/session-protocol';
import { Type } from 'typebox';
import { afterEach, expect, it, vi } from 'vitest';
import { OrderedAdmission } from '../src/daemon/admission.js';
import { createRegistryInteractionBroker, type InteractionBroker } from '../src/daemon/broker.js';
import { createDaemonExecutionServices } from '../src/daemon/execution-services.js';
import { toolId, toolName } from '../src/daemon/message-sanitize.js';
import type { SessionRuntime } from '../src/daemon/session-runtime.js';
import { assistant } from './fixtures/registry.js';
import { requestId, serverFixture } from './fixtures/server.js';
import { createTestSessionRuntime } from './fixtures/session-runtime.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it.each([
  { label: 'a 400-character tool id', id: `call|${'x'.repeat(395)}`, name: 'approval_probe' },
  { label: 'an empty tool name', id: 'empty-name-call', name: '' },
  { label: 'a lone surrogate in the tool name', id: 'surrogate-name-call', name: '\ud800approval_probe' },
])('matches approval ids to projected calls and runs $label with its raw id', async ({ id, name }) => {
  let broker!: InteractionBroker;
  const execute = vi.fn(async (_toolCallId: string) => ({ content: [{ type: 'text' as const, text: 'approved' }] }));
  const composition: SessionRuntime = {
    ...createTestSessionRuntime(),
    async bindExtensions(context) {
      let called = false;
      return {
        importExtension: context.importExtension,
        inlineExtensions: [{ name: 'approval-probe', factory: pi => {
          pi.registerTool({ name, label: 'Approval probe', description: 'An approval test tool', parameters: Type.Object({}), execute });
        } }],
        wrapStreamFunction: original => (...args) => {
          if (called) return original(...args);
          called = true;
          const stream = createAssistantMessageEventStream();
          stream.push({ type: 'done', reason: 'toolUse', message: { ...assistant(), stopReason: 'toolUse',
            content: [{ type: 'toolCall', id, name, arguments: {} }] } });
          return stream;
        },
        async dispose() {},
      };
    },
  };
  const f = await serverFixture({ deferActivation: true, composition, servicesFactory: registry => {
    broker = createRegistryInteractionBroker(registry);
    return createDaemonExecutionServices(registry, broker, composition);
  } });
  cleanups.push(async () => { await broker.drain(); await f.dispose(); });
  const session = f.root.sessionId;
  f.registry.tightenPolicy(session);
  const client = { principal: 'owner', kind: 'headless' as const, attachment: 'client', interactionKinds: ['tool_approval' as const] };
  broker.connected({ ...client, sessions: [session] });
  const events: SessionEvent[] = [];
  f.registry.subscribe(session, event => { if ('change' in event) events.push(event); });
  const pendingRun = f.root.runtime.session.prompt('Run the approval probe.');
  cleanups.push(async () => { await broker.drain(); await pendingRun; });
  await vi.waitFor(() => expect(broker.pending()).toHaveLength(1));
  const interaction = broker.pending()[0]!;
  expect(parseInteraction(interaction)).toEqual(interaction);
  expect(interaction.request).toMatchObject({ kind: 'tool_approval', toolCallId: toolId(id), toolName: toolName(name),
    summary: `${toolName(name)}\n{}` });
  const call = f.registry.projection(session).snapshot().history.entries.flatMap(message => message.content)
    .find(part => part.type === 'tool_call');
  expect(call).toMatchObject({ type: 'tool_call', id: toolId(id), name: toolName(name) });
  expect(execute).not.toHaveBeenCalled();

  const admission = new OrderedAdmission(f.store);
  const answer = await admission.submit(parseClientEnvelope({ v: 1, id: requestId(), op: 'interaction.answer', session,
    params: { interactionId: interaction.id, answer: { kind: 'tool_approval', optionId: 'allow-once' } },
  }), client.principal, command => broker.dispatch(command, client));
  expect(answer).toMatchObject({ outcome: 'accepted' });
  await pendingRun;
  f.registry.projection(session).refresh();
  await f.registry.settleWriters();
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![0]).toBe(id);
  expect(broker.pending()).toEqual([]);
  expect(events.some(event => event.change.type === 'tool.updated'
    && event.change.tool.id === toolId(id) && event.change.tool.name === toolName(name)
    && event.change.tool.state === 'completed')).toBe(true);
  expect(f.root.runtime.session.sessionManager.getEntries()).toContainEqual(expect.objectContaining({ type: 'message',
    message: expect.objectContaining({ role: 'toolResult', toolCallId: id, toolName: name, isError: false }),
  }));
});

it.each([
  { label: 'undefined input', input: () => undefined, summary: '[Tool input could not be displayed.]' },
  { label: 'circular input', input: () => {
    const value: { self?: unknown } = {}; value.self = value; return value;
  }, summary: '[Tool input could not be displayed.]' },
  { label: 'BigInt input', input: () => ({ value: 1n }), summary: '[Tool input could not be displayed.]' },
  { label: 'a throwing serialization hook', input: () => ({ toJSON() { throw new Error('Cannot serialize'); } }),
    summary: '[Tool input could not be displayed.]' },
  { label: 'ordinary JSON input', input: () => ({ path: 'file.txt', enabled: true }), summary: '{"path":"file.txt","enabled":true}' },
  { label: 'a lone surrogate in the input', input: () => '\ud800', summary: '"\\ud800"' },
  { label: 'ASCII input beyond the byte limit', input: () => 'x'.repeat(24_000), summary: `"${'x'.repeat(23_999)}` },
  ...['é', '€', '🙂'].flatMap(point => [
    { label: `a ${Buffer.byteLength(point)}-byte character across the byte limit`,
      input: () => `${'x'.repeat(23_998)}${point}`, summary: `"${'x'.repeat(23_998)}` },
    { label: `a ${Buffer.byteLength(point)}-byte character ending at the byte limit`,
      input: () => `${'x'.repeat(23_999 - Buffer.byteLength(point))}${point}tail`,
      summary: `"${'x'.repeat(23_999 - Buffer.byteLength(point))}${point}` },
  ]),
])('creates an approvable interaction for $label', async ({ input, summary }) => {
  const f = await serverFixture();
  const broker = createRegistryInteractionBroker(f.registry);
  cleanups.push(async () => { await broker.drain(); await f.dispose(); });
  const session = f.root.sessionId;
  f.registry.tightenPolicy(session);
  const client = { principal: 'owner', kind: 'headless' as const, attachment: 'client', interactionKinds: ['tool_approval' as const] };
  broker.connected({ ...client, sessions: [session] });
  const on = vi.fn();
  await broker.approvalExtension(f.registry).factory({ on } as unknown as ExtensionAPI);
  expect(on).toHaveBeenCalledOnce();
  expect(on.mock.calls[0]![0]).toBe('tool_call');
  const pending = on.mock.calls[0]![1]({ type: 'tool_call', toolCallId: 'summary-call', toolName: 'approval_probe', input: input() },
    { sessionManager: f.root.runtime.session.sessionManager }).catch((error: unknown) => ({ error }));
  expect(broker.pending()).toHaveLength(1);
  const interaction = broker.pending()[0]!;
  expect(parseInteraction(interaction)).toEqual(interaction);
  expect(interaction.request).toMatchObject({ kind: 'tool_approval', toolName: 'approval_probe', summary: `approval_probe\n${summary}` });
  expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(24_000);

  const admission = new OrderedAdmission(f.store);
  const answer = await admission.submit(parseClientEnvelope({ v: 1, id: requestId(), op: 'interaction.answer', session,
    params: { interactionId: interaction.id, answer: { kind: 'tool_approval', optionId: 'allow-once' } },
  }), client.principal, command => broker.dispatch(command, client));
  expect(answer).toMatchObject({ outcome: 'accepted' });
  await expect(pending).resolves.toBeUndefined();
  expect(broker.pending()).toEqual([]);
});
