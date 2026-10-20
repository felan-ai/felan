import type { AgentContext } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseInteraction, type Interaction, type Presentation, type UiForm, type UiView } from '@felan-ai/session-protocol';
import { AcpProtocolInteractions, genericElicitationSchema } from '../src/acp/protocol-interactions.js';
import type { AcpProtocolUpdates } from '../src/acp/protocol-updates.js';
import type { SessionClient } from '../src/client/client.js';
import { GENERIC_UI_CAPABILITIES } from '../src/client/ui.js';
import { snapshot } from './client-fixtures.js';

const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });
const form: UiForm = { title: 'Question', markdown: 'Full context', fallback: 'Answer', input: {
  fields: [{ id: 'value', kind: 'string', label: 'Answer', required: true, maxLength: 100 }], defaults: { value: 'Draft' },
}, actions: [{ id: 'send', label: 'Submit', target: 'element', outcome: 'submit' }, { id: 'cancel', label: 'Cancel', target: 'element', outcome: 'cancel' }] };

function fixture(supportsForms = true, negotiated = true, handlesHostInteractions = () => true) {
  let connection = 'ready'; let revisionState = 'live'; let interactions: Interaction[] = [];
  let presentation: Presentation[] = [];
  const daemonRequest = vi.fn(async () => ({ outcome: 'accepted', result: {} }));
  const request = vi.fn(async (..._args: unknown[]) => ({ action: 'decline', content: {} }));
  const send = vi.fn(); const report = vi.fn();
  const daemon = {
    get status() { return connection; }, capabilities: { operations: ['ui.action'], capabilities: negotiated ? [...GENERIC_UI_CAPABILITIES] : [],
      interactionKinds: ['tool_approval', 'form', 'select', 'confirm', 'input', 'editor', 'ask_user', 'trust', 'dependency'] },
    getInteractions: () => interactions,
    getAttachment: () => ({ state: { status: revisionState, snapshot: { ...snapshot(), presentation } } }), request: daemonRequest,
  } as unknown as SessionClient;
  const handler = new AcpProtocolInteractions(daemon, 'session', { request } as unknown as AgentContext,
    { send, flush: async () => {}, toolId: (id: string) => id } as unknown as AcpProtocolUpdates, supportsForms, report, handlesHostInteractions);
  disposals.push(() => handler.close());
  return { handler, request, daemonRequest, send, report,
    interactions: (values: Interaction[]) => { interactions = values; },
    form: (definition = form) => { interactions = [parseInteraction({ id: 'question', createdAt: Date.now(), state: 'waiting',
      scope: { kind: 'session', session: 'session', root: 'session' }, request: { kind: 'form', form: definition } })]; },
    elements: (values: Presentation[]) => { presentation = values; },
    connection: (status: string, state = 'live') => { connection = status; revisionState = state; } };
}

describe('ACP generic protocol UI', () => {
  it('answers broker-authorized host forms without adding a session scope', async () => {
    const f = fixture();
    f.interactions([parseInteraction({ id: 'host-form', createdAt: Date.now(), state: 'waiting', scope: { kind: 'host' },
      authority: 'local-console',
      request: { kind: 'form', form: { ...form, input: { fields: [] } } } })]);
    f.request.mockResolvedValueOnce({ action: 'accept', content: { choice: 'send' } });
    f.handler.reconcile();
    await vi.waitFor(() => expect(f.daemonRequest).toHaveBeenCalledOnce());
    expect(f.daemonRequest).toHaveBeenCalledWith('interaction.answer', { interactionId: 'host-form',
      answer: { kind: 'form', actionId: 'send', outcome: 'submit', values: {} } }, undefined);
  });

  it.each(['dependency'] as const)('renders negotiated %s host prompts through elicitation', async kind => {
    const f = fixture();
    f.interactions([parseInteraction({ id: 'host-prompt', createdAt: Date.now(), state: 'waiting', scope: { kind: 'host' },
      authority: 'local-console', request: { kind, dependency: 'test-tool', message: 'Install test tool?' } })]);
    f.request.mockResolvedValueOnce({ action: 'accept', content: { value: true } });
    f.handler.reconcile();
    await vi.waitFor(() => expect(f.daemonRequest).toHaveBeenCalledOnce());
    expect(f.daemonRequest).toHaveBeenCalledWith('interaction.answer', { interactionId: 'host-prompt',
      answer: { kind, approved: true } }, undefined);
  });

  it('hands off host presentation without submitting a late result from its previous presenter', async () => {
    let owns = false;
    const f = fixture(true, true, () => owns);
    f.interactions([parseInteraction({ id: 'host-form', createdAt: Date.now(), state: 'waiting', scope: { kind: 'host' },
      request: { kind: 'form', form: { ...form, input: { fields: [] } } } })]);
    let finish!: (value: { action: string; content: Record<string, unknown> }) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.handler.reconcile(); expect(f.request).not.toHaveBeenCalled();
    owns = true; f.handler.reconcile();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    owns = false; f.handler.reconcile();
    expect((f.request.mock.calls[0]?.[2] as { cancellationSignal: AbortSignal }).cancellationSignal.aborted).toBe(true);
    finish({ action: 'accept', content: { choice: 'send' } });
    await Promise.resolve(); expect(f.daemonRequest).not.toHaveBeenCalled();
  });

  it('elicits action choice and genuine typed fields, preserving defaults and canonical answers', async () => {
    const f = fixture(); f.form();
    f.request.mockResolvedValueOnce({ action: 'accept', content: { choice: 'send' } })
      .mockResolvedValueOnce({ action: 'accept', content: { value: 'Typed' } });
    f.handler.reconcile();
    await vi.waitFor(() => expect(f.daemonRequest).toHaveBeenCalledOnce());
    expect(f.request.mock.calls[0]?.[0]).toBe('elicitation/create');
    expect(f.request.mock.calls[0]?.[1]).toMatchObject({ message: expect.stringContaining('Full context') });
    expect(f.request.mock.calls[1]?.[1]).toMatchObject({ requestedSchema: { properties: { value: { type: 'string', default: 'Draft', maxLength: 100 } }, required: ['value'] } });
    expect(f.daemonRequest).toHaveBeenCalledWith('interaction.answer', { interactionId: 'question',
      answer: { kind: 'form', actionId: 'send', outcome: 'submit', values: { value: 'Typed' } } }, { session: 'session' });
  });

  it('handles zero-field forms and explicit cancel without eliciting irrelevant inputs', async () => {
    const f = fixture(); f.form({ ...form, input: { fields: [] } });
    f.request.mockResolvedValueOnce({ action: 'accept', content: { choice: 'send' } });
    f.handler.reconcile(); await vi.waitFor(() => expect(f.daemonRequest).toHaveBeenCalledOnce());
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.daemonRequest.mock.calls[0]).toMatchObject(['interaction.answer', { answer: { values: {}, outcome: 'submit' } }, { session: 'session' }]);
    const cancel = fixture(); cancel.form();
    cancel.request.mockResolvedValueOnce({ action: 'accept', content: { choice: 'cancel' } });
    cancel.handler.reconcile(); await vi.waitFor(() => expect(cancel.daemonRequest).toHaveBeenCalledOnce());
    expect(cancel.request).toHaveBeenCalledOnce();
    expect(cancel.daemonRequest.mock.calls[0]).toMatchObject(['interaction.answer', { answer: { actionId: 'cancel', values: {}, outcome: 'cancel' } }, { session: 'session' }]);
  });

  it('exposes query, row actions and paging through elicitation instead of a fallback line', async () => {
    const f = fixture();
    const view: UiView = { id: 'view', kind: 'view', revision: 2, title: 'Records', fallback: 'Records',
      fields: [{ id: 'name', label: 'Name', valueKind: 'text' }], items: [{ id: 'row', values: { name: 'Actual row' }, fallback: 'row' }],
      actions: [{ id: 'query', label: 'Search', target: 'element', outcome: 'submit', input: form.input },
        { id: 'open', label: 'Open', target: 'item', outcome: 'submit' }, { id: 'next', label: 'Next', target: 'element', outcome: 'submit' }],
      query: { actionId: 'query', values: { value: 'Current' } }, paging: { nextActionId: 'next' } };
    f.elements([view]);
    f.request.mockResolvedValueOnce({ action: 'accept', content: { choice: '1' } });
    f.handler.reconcile(); await vi.waitFor(() => expect(f.daemonRequest).toHaveBeenCalledOnce());
    expect(f.request.mock.calls[0]?.[1]).toMatchObject({ message: expect.stringContaining('Actual row'),
      requestedSchema: { properties: { choice: { oneOf: expect.arrayContaining([{ const: '1', title: 'Open — row' }]) } } } });
    expect(f.daemonRequest).toHaveBeenCalledWith('ui.action', { elementId: 'view', revision: 2, actionId: 'open', itemId: 'row', outcome: 'submit', values: {} }, { session: 'session' });
    f.elements([{ ...view, revision: 3 }]);
    f.request.mockResolvedValueOnce({ action: 'accept', content: { choice: '0' } }).mockResolvedValueOnce({ action: 'accept', content: { value: 'New query' } });
    f.handler.reconcile(); await vi.waitFor(() => expect(f.daemonRequest).toHaveBeenCalledTimes(2));
    expect(f.request.mock.calls[2]?.[1]).toMatchObject({ requestedSchema: { properties: { value: { default: 'Current' } } } });
  });

  it('rejects malformed answers and fences stale/disconnected elicitation replies', async () => {
    const malformed = fixture(); malformed.form();
    malformed.request.mockResolvedValueOnce({ action: 'accept', content: { choice: 'send' } }).mockResolvedValueOnce({ action: 'accept', content: {} });
    malformed.handler.reconcile(); await vi.waitFor(() => expect(malformed.report).toHaveBeenCalledOnce());
    expect(malformed.daemonRequest).not.toHaveBeenCalled();
    const f = fixture(); f.form();
    let finish!: (value: { action: string; content: Record<string, unknown> }) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.handler.reconcile(); await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    f.connection('disconnected', 'disconnected'); f.handler.reconcile();
    expect((f.request.mock.calls[0]?.[2] as { cancellationSignal: AbortSignal }).cancellationSignal.aborted).toBe(true);
    finish({ action: 'accept', content: { choice: 'send' } });
    await Promise.resolve(); expect(f.daemonRequest).not.toHaveBeenCalled();
    f.connection('ready'); f.request.mockResolvedValueOnce({ action: 'accept', content: { choice: 'cancel' } });
    f.handler.reconcile(); await vi.waitFor(() => expect(f.daemonRequest).toHaveBeenCalledOnce());
  });

  it('does not offer controls without negotiated capabilities, but displays real read-only content', async () => {
    const f = fixture(false, false);
    f.elements([{ id: 'doc', kind: 'document', revision: 1, title: 'Report', markdown: 'Detailed report', fallback: 'Short fallback',
      actions: [{ id: 'run', label: 'Run action', target: 'element', outcome: 'submit' }] }]);
    f.handler.reconcile(); await vi.waitFor(() => expect(f.send).toHaveBeenCalled());
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ content: { type: 'text', text: expect.stringContaining('Detailed report') } }));
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ content: { type: 'text', text: expect.stringContaining('Controls unavailable') } }));
    expect(f.request).not.toHaveBeenCalled(); expect(f.daemonRequest).not.toHaveBeenCalled();
  });

  it('invalidates an elicitation dialog when its element revision changes', async () => {
    const f = fixture();
    let finish!: (value: { action: string; content: Record<string, unknown> }) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const doc = { id: 'doc', kind: 'document' as const, revision: 1, title: 'Report', markdown: 'Old report', fallback: 'Report',
      actions: [{ id: 'close', label: 'Close', target: 'element' as const, outcome: 'cancel' as const }] };
    f.elements([doc]); f.handler.reconcile();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    f.elements([{ ...doc, revision: 2, markdown: 'New report', actions: [] }]); f.handler.reconcile();
    expect((f.request.mock.calls[0]?.[2] as { cancellationSignal: AbortSignal }).cancellationSignal.aborted).toBe(true);
    finish({ action: 'accept', content: { choice: '0' } });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalled());
    expect(f.daemonRequest).not.toHaveBeenCalled();
  });

  it('maps enum identities, multi-selection bounds and zero-field schemas using supported ACP fields', () => {
    expect(genericElicitationSchema({ fields: [] })).toMatchObject({ properties: {}, required: [] });
    expect(genericElicitationSchema({ fields: [{ id: 'many', label: 'Choose', kind: 'multi_select', required: true,
      options: [{ id: 'a', label: 'Same' }, { id: 'b', label: 'Same' }], maxSelections: 1 }], defaults: { many: ['b'] } }))
      .toMatchObject({ properties: { many: { type: 'array', items: { enum: ['a', 'b'] }, maxItems: 1, default: ['b'] } }, required: ['many'] });
  });
});
