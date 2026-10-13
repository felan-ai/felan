import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentContext } from '@agentclientprotocol/sdk';
import { afterEach, expect, it, vi } from 'vitest';
import { identityFor } from '../../daemon/src/daemon/target.js';
import { parseInteraction, type ClientEnvelope, type Interaction, type Presentation, type SessionSnapshot } from '@felan-ai/session-protocol';
import { SessionClient, type SessionClientOptions } from '../src/client/client.js';
import { ClientInteractionPresenters, type InteractionPresenterUi } from '../src/client/presenters.js';
import { TuiSessionController } from '../src/tui/controller.js';
import { TERMINAL_INTERACTION_KINDS, TERMINAL_UI_CAPABILITIES, TerminalInteractions } from '../src/tui/interactions.js';
import { AcpSessionRegistry } from '../src/acp/session-registry.js';
import { ACP_UI_CAPABILITIES } from '../src/acp/protocol-interactions.js';
import { runDaemonFelan } from '../src/client-application.js';
import { FakeTransport, snapshot } from './client-fixtures.js';
import askUser from '../../../packages/ext-ask-user/src/extension.js';
import { commitForm, extensionFixture } from './generic-extension-ui-fixtures.js';
import { createUnavailableExtensionUi, type UiRequestResult, type UiForm } from '@felan-ai/agent-core';
import { createUiAskUserHost } from '../../../packages/ext-ask-user/src/ui.js';
import { createPrewalkUiHost } from '../../../packages/ext-prewalk/src/ui.js';
import { createTerminalPresenters } from '../src/tui/presenters.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

function question(): Interaction {
  return parseInteraction({ id: 'question', state: 'waiting', createdAt: Date.now(),
    scope: { kind: 'session', session: 'session', root: 'session' }, request: { kind: 'form', form: {
      title: 'Question', markdown: 'Actual context', fallback: 'Choose', input: { fields: [] },
      actions: [{ id: 'send', label: 'Send', target: 'element', outcome: 'submit' }, { id: 'cancel', label: 'Cancel', target: 'element', outcome: 'cancel' }],
    } } });
}
const document: Presentation = { id: 'document', kind: 'document', revision: 1, title: 'Report', markdown: 'Full report, not a fallback', actions: [], fallback: 'Report' };
const view: Presentation = { id: 'view', kind: 'view', revision: 1, title: 'Results', fallback: 'Results',
  fields: [{ id: 'text', label: 'Text', valueKind: 'text' }], items: [{ id: 'row', values: { text: 'Actual row' }, fallback: 'Row' }],
  actions: [{ id: 'open', label: 'Open', target: 'item', outcome: 'submit' }] };

async function wire(uiAvailable = true) {
  const directory = await mkdtemp(join(tmpdir(), 'generic-client-'));
  const fake = new FakeTransport(); const clients: SessionClient[] = []; const offered: SessionClientOptions[] = [];
  let current: SessionSnapshot = { ...snapshot(), cwd: directory };
  let mutation: (request: ClientEnvelope, connection: number) => void = (request, connection) => fake.reply(request, {}, connection);
  function createClient(options: SessionClientOptions): SessionClient {
    offered.push(options);
    const { launch: _launch, ...rest } = options;
    const client = new SessionClient({ ...rest, target: { kind: 'isolated', directory, namespaceId: 'generic-test' },
      connector: fake.connector, requestTimeoutMs: 200, reconnectDelayMs: 0, retries: 2 });
    clients.push(client); return client;
  }
  fake.onSend = (request, connection) => {
    if (request.op === 'hello') {
      const options = offered.at(-1)!;
      fake.reply(request, { attachmentId: `client-${connection}`, principal: 'principal', daemonVersion: options.expectedDaemonVersion ?? 'fixture',
        protocol: 1, identity: identityFor(clients.at(-1)!.target, 'instance'), operations: ['attach', 'detach', 'sessions.list', 'session.history', 'interaction.answer',
          ...(uiAvailable && (request.params.capabilities ?? []).includes('ui.action') ? ['ui.action'] : [])],
        interactionKinds: uiAvailable ? request.params.interactionKinds : [], capabilities: uiAvailable ? request.params.capabilities ?? [] : [] }, connection);
    } else if (request.op === 'sessions.list') fake.reply(request, { entries: [{ session: current.session, root: current.root,
      cwd: current.cwd, title: current.title, state: current.state, residency: current.residency,
      revision: current.revision, run: current.run, policy: current.policy, lastActivity: 1 }] }, connection);
    else if (request.op === 'attach') fake.reply(request, { attachmentId: `binding-${connection}`, snapshot: current }, connection);
    else if (request.op === 'session.history') fake.reply(request, current.history, connection);
    else if (request.op === 'detach') fake.reply(request, {}, connection);
    else mutation(request, connection);
  };
  cleanup.push(async () => { for (const client of clients) client.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, fake, offered, clients, createClient,
    state: (value: Partial<SessionSnapshot>) => { current = { ...current, ...value }; },
    handle: (handler: typeof mutation) => { mutation = handler; },
    presentation(value: Presentation) {
      current = { ...current, revision: current.revision + 1, presentation: [...current.presentation.filter(item => item.id !== value.id), value] };
      fake.frame({ v: 1, session: 'session', rev: current.revision, change: { type: 'presentation.updated', presentation: value } });
    } };
}

it('the production TUI creation path offers generic capabilities without launching a daemon', async () => {
  const f = await wire();
  await runDaemonFelan({ cwd: f.directory, daemonRuntime: f.directory }, { createClient: f.createClient, runTerminal: async () => {} });
  expect(f.offered).toHaveLength(1);
  expect(f.offered[0]?.capabilities).toEqual([...TERMINAL_UI_CAPABILITIES]);
  expect(f.offered[0]?.interactionKinds).toContain('form');
});

it.each([true, false])('ACP negotiates actual elicitation support (%s) and renders a no-hint document', async supportsForms => {
  const f = await wire(); f.state({ presentation: [document] });
  const registry = new AcpSessionRegistry({ createClient: f.createClient }); cleanup.push(() => registry.dispose());
  registry.initialize(supportsForms ? { elicitation: { form: {} } } : {});
  const notify = vi.fn(async () => {}); const request = vi.fn(async () => ({ action: 'decline' }));
  await registry.loadSession({ sessionId: 'session', cwd: f.directory, mcpServers: [] }, { notify, request } as unknown as AgentContext);
  const hello = f.fake.requests.find(request => request.op === 'hello')!;
  expect(hello.params).toMatchObject({ capabilities: supportsForms ? [...ACP_UI_CAPABILITIES]
    : ACP_UI_CAPABILITIES.filter(value => value !== 'ui.action') });
  expect(f.offered[0]?.interactionKinds?.includes('form')).toBe(supportsForms);
  expect(f.fake.requests.find(request => request.op === 'attach')?.params).toMatchObject({ requirePolicy: 'acp-strict' });
  await vi.waitFor(() => expect(JSON.stringify(notify.mock.calls)).toContain('Full report, not a fallback'));
  expect(request).not.toHaveBeenCalled();
});

it('ACP aborts an unanswered dialog on disconnect and re-elicits the still-pending form after attachment recovery', async () => {
  const f = await wire(); f.state({ interactions: [question()] });
  const registry = new AcpSessionRegistry({ createClient: f.createClient }); cleanup.push(() => registry.dispose());
  registry.initialize({ elicitation: { form: {} } });
  const signals: AbortSignal[] = [];
  const request = vi.fn(async (_method: unknown, _params: unknown, options: { cancellationSignal: AbortSignal }) => {
    signals.push(options.cancellationSignal);
    if (signals.length > 1) return { action: 'accept', content: { choice: 'cancel' } };
    return new Promise<never>(() => {});
  });
  await registry.loadSession({ sessionId: 'session', cwd: f.directory, mcpServers: [] }, { request, notify: vi.fn(async () => {}) } as unknown as AgentContext);
  await vi.waitFor(() => expect(signals).toHaveLength(1)); f.fake.lose();
  await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
  await vi.waitFor(() => expect(f.fake.requests.some(item => item.op === 'interaction.answer')).toBe(true));
  const answer = f.fake.requests.find(item => item.op === 'interaction.answer');
  expect(answer?.params).toMatchObject({ answer: { kind: 'form', actionId: 'cancel', outcome: 'cancel', values: {} } });
});

it('ACP retains an already-submitted cancellation across reconnect and awaits the broker response', async () => {
  const f = await wire(); f.state({ interactions: [question()] });
  const diagnostic = vi.fn(); const request = vi.fn(async () => ({ action: 'accept', content: { choice: 'cancel' } }));
  const registry = new AcpSessionRegistry({ createClient: f.createClient, writeDiagnostic: diagnostic }); cleanup.push(() => registry.dispose());
  registry.initialize({ elicitation: { form: {} } });
  f.handle(() => {});
  await registry.loadSession({ sessionId: 'session', cwd: f.directory, mcpServers: [] }, { request, notify: vi.fn(async () => {}) } as unknown as AgentContext);
  await vi.waitFor(() => expect(f.fake.requests.filter(item => item.op === 'interaction.answer')).toHaveLength(1));
  const first = f.fake.requests.find(item => item.op === 'interaction.answer')!;
  f.fake.lose();
  await vi.waitFor(() => expect(f.fake.requests.filter(item => item.op === 'interaction.answer').length).toBeGreaterThan(1));
  expect(request).toHaveBeenCalledOnce();
  expect(new Set(f.fake.requests.filter(item => item.op === 'interaction.answer').map(item => item.id)).size).toBe(1);
  expect(f.clients[0]!.getRequest(first.id)?.status).toBe('pending');
  f.fake.frame({ v: 1, re: first.id, outcome: 'indeterminate', error: { code: 'indeterminate', message: 'Broker outcome is unknown', retryable: false } });
  await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('Broker outcome is unknown')));
  expect(request).toHaveBeenCalledOnce();
});

it('TUI sends canonical no-hint answers and item actions, waits for acknowledgement, and can reopen passive documents', async () => {
  const f = await wire(); f.state({ interactions: [question()], presentation: [document, view] });
  const client = f.createClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: 'ignored' }, kind: 'tui', clientVersion: 'fixture',
    interactionKinds: [...TERMINAL_INTERACTION_KINDS], capabilities: [...TERMINAL_UI_CAPABILITIES] });
  const controller = new TuiSessionController(client); cleanup.push(() => controller.dispose());
  const ui = { select: vi.fn(async (_title: string, choices: string[]) => choices[0]), custom: vi.fn(async () => true), input: vi.fn(), notify: vi.fn() } as unknown as InteractionPresenterUi;
  const presenters = new ClientInteractionPresenters(ui); const shown = vi.spyOn(presenters, 'presentElement');
  const interactions = new TerminalInteractions(controller, presenters); cleanup.push(() => interactions.dispose());
  f.handle(() => {});
  await controller.start({ cwd: f.directory, sessionId: 'session' });
  await vi.waitFor(() => expect(f.fake.requests.some(item => item.op === 'interaction.answer')).toBe(true));
  expect(interactions.busy).toBe(true); expect(shown).not.toHaveBeenCalled();
  const answer = f.fake.requests.find(item => item.op === 'interaction.answer')!;
  expect(answer.params).toMatchObject({ answer: { kind: 'form', actionId: 'send', outcome: 'submit', values: {} } });
  f.fake.reply(answer, {});
  await vi.waitFor(() => expect(f.fake.requests.some(item => item.op === 'ui.action')).toBe(true));
  const action = f.fake.requests.find(item => item.op === 'ui.action')!;
  expect(action.params).toEqual({ elementId: 'view', revision: 1, actionId: 'open', itemId: 'row', outcome: 'submit', values: {} });
  expect(interactions.busy).toBe(true); expect(client.getRequest(action.id)?.status).toBe('pending');
  f.fake.reply(action, {}); await vi.waitFor(() => expect(interactions.busy).toBe(false));
  interactions.showElement('document');
  await vi.waitFor(() => expect(shown).toHaveBeenCalledWith(document, expect.any(AbortSignal), true));
  await vi.waitFor(() => expect(interactions.busy).toBe(false));
  interactions.showElement('document'); await vi.waitFor(() => expect(shown).toHaveBeenCalledTimes(3));
  expect(f.fake.requests.some(item => item.op === 'prompt')).toBe(false);
});

it('TUI keeps a submitted generic action pending through reconnect without creating a new action ID', async () => {
  const f = await wire(); f.state({ presentation: [view] }); f.handle(() => {});
  const client = f.createClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: 'ignored' }, kind: 'tui', clientVersion: 'fixture',
    interactionKinds: [...TERMINAL_INTERACTION_KINDS], capabilities: [...TERMINAL_UI_CAPABILITIES] });
  const controller = new TuiSessionController(client); cleanup.push(() => controller.dispose());
  const ui = { select: vi.fn(async (_title: string, choices: string[]) => choices[0]), custom: vi.fn(async () => true), notify: vi.fn() } as unknown as InteractionPresenterUi;
  const presenters = new ClientInteractionPresenters(ui); const shown = vi.spyOn(presenters, 'presentElement');
  const interactions = new TerminalInteractions(controller, presenters); cleanup.push(() => interactions.dispose());
  await controller.start({ cwd: f.directory, sessionId: 'session' });
  await vi.waitFor(() => expect(f.fake.requests.some(item => item.op === 'ui.action')).toBe(true));
  const action = f.fake.requests.find(item => item.op === 'ui.action')!; f.fake.lose();
  await vi.waitFor(() => expect(f.fake.requests.filter(item => item.op === 'ui.action').length).toBeGreaterThan(1));
  expect(shown).toHaveBeenCalledOnce(); expect(interactions.busy).toBe(true);
  expect(new Set(f.fake.requests.filter(item => item.op === 'ui.action').map(item => item.id)).size).toBe(1);
  f.fake.frame({ v: 1, re: action.id, outcome: 'rejected', error: { code: 'invalid_request', message: 'The action was not committed', retryable: false } });
  await vi.waitFor(() => expect(interactions.busy).toBe(false));
  expect(controller.notice).toContain('The action was not committed');
  expect(shown).toHaveBeenCalledOnce();
});

it('an unsupported daemon cannot turn offered TUI capabilities into fake form or action success', async () => {
  const f = await wire(false); f.state({ interactions: [question()], presentation: [view] });
  const client = f.createClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: 'ignored' }, kind: 'tui', clientVersion: 'fixture',
    interactionKinds: [...TERMINAL_INTERACTION_KINDS], capabilities: [...TERMINAL_UI_CAPABILITIES] });
  const controller = new TuiSessionController(client); cleanup.push(() => controller.dispose());
  const select = vi.fn(async () => 'not-an-authorized-answer');
  const ui = { select, custom: vi.fn(async () => true), notify: vi.fn() } as unknown as InteractionPresenterUi;
  const presenters = new ClientInteractionPresenters(ui); const shown = vi.spyOn(presenters, 'presentElement');
  const interactions = new TerminalInteractions(controller, presenters); cleanup.push(() => interactions.dispose());
  await controller.start({ cwd: f.directory, sessionId: 'session' });
  await vi.waitFor(() => expect(shown).toHaveBeenCalledWith(view, expect.any(AbortSignal), false));
  await vi.waitFor(() => expect(interactions.busy).toBe(false));
  expect(select).not.toHaveBeenCalled();
  expect(f.fake.requests.filter(item => item.op === 'interaction.answer' || item.op === 'ui.action')).toHaveLength(0);
  expect(controller.notice).toContain('not negotiated');
});

it.each(['tui', 'acp'] as const)('keeps a real ask-user cancellation pending across %s reconnect until the broker replies', async kind => {
  const h = extensionFixture(); await h.install(askUser);
  let completed = false;
  const work = h.tool('ask_user', { question: 'Continue with this change?' }).then(value => { completed = true; return value; });
  await vi.waitFor(() => expect(h.forms).toHaveLength(1));
  const row = h.forms[0]!;
  const f = await wire(); f.handle(() => {});
  f.state({ interactions: [parseInteraction({ id: 'question', createdAt: Date.now(), state: 'waiting',
    scope: { kind: 'session', session: 'session', root: 'session' },
    request: { kind: 'form', form: row.form } })] });
  if (kind === 'tui') {
    const client = f.createClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: 'ignored' }, kind,
      clientVersion: 'fixture', interactionKinds: [...TERMINAL_INTERACTION_KINDS], capabilities: [...TERMINAL_UI_CAPABILITIES] });
    const controller = new TuiSessionController(client); cleanup.push(() => controller.dispose());
    const ui = { select: vi.fn(async (_title: string, choices: string[]) => choices.at(-1)),
      custom: vi.fn(async () => true), notify: vi.fn() } as unknown as InteractionPresenterUi;
    const interactions = new TerminalInteractions(controller, new ClientInteractionPresenters(ui));
    cleanup.push(() => interactions.dispose());
    await controller.start({ cwd: f.directory, sessionId: 'session' });
  } else {
    const registry = new AcpSessionRegistry({ createClient: f.createClient }); cleanup.push(() => registry.dispose());
    registry.initialize({ elicitation: { form: {} } });
    await registry.loadSession({ sessionId: 'session', cwd: f.directory, mcpServers: [] }, {
      notify: vi.fn(async () => {}), request: vi.fn(async () => ({ action: 'accept', content: { choice: 'cancel' } })),
    } as unknown as AgentContext);
  }
  cleanup.push(async () => {
    for (const request of f.fake.requests) if (request.op === 'interaction.answer' && f.clients.some(client => client.getRequest(request.id)?.status === 'pending')) {
      f.fake.frame({ v: 1, re: request.id, outcome: 'rejected', error: { code: 'invalid_request', message: 'Fixture cleanup', retryable: false } });
    }
    row.reply({ state: 'cancelled', reason: 'abort' }); await work;
  });
  await vi.waitFor(() => expect(f.fake.requests.filter(request => request.op === 'interaction.answer')).toHaveLength(1));
  const original = f.fake.requests.find(request => request.op === 'interaction.answer')!;
  expect(original.params).toMatchObject({ answer: { kind: 'form', actionId: 'cancel', outcome: 'cancel', values: {} } });
  expect(f.clients[0]!.getRequest(original.id)?.status).toBe('pending'); expect(completed).toBe(false);
  f.fake.lose();
  await vi.waitFor(() => expect(f.fake.requests.filter(request => request.op === 'interaction.answer').length).toBeGreaterThan(1));
  expect(new Set(f.fake.requests.filter(request => request.op === 'interaction.answer').map(request => request.id)).size).toBe(1);
  expect(f.clients[0]!.getRequest(original.id)?.status).toBe('pending'); expect(completed).toBe(false);
  f.fake.frame({ v: 1, re: original.id, outcome: 'accepted', result: {} });
  await vi.waitFor(() => expect(f.clients[0]!.getRequest(original.id)?.status).toBe('accepted'));
  commitForm(row, original.params);
  expect(await work).toMatchObject({ details: { status: 'cancelled', reason: 'user' } });
});

it.each(['ask-user', 'prewalk'] as const)('renders the same hinted %s form richly in the TUI and generically in ACP', async feature => {
  let form!: UiForm; let reply!: (result: UiRequestResult) => void;
  const ui = { ...createUnavailableExtensionUi(), request: async (value: UiForm): Promise<UiRequestResult> => {
    form = value;
    return new Promise(resolve => { reply = resolve; });
  } };
  const prewalk = createPrewalkUiHost(ui);
  const work = feature === 'ask-user'
    ? createUiAskUserHost(ui).ask({ questions: [{ id: 'q1', header: 'Scope', question: 'Choose scope?',
      options: [{ title: 'First' }, { title: 'Second' }], allowMultiple: false, allowFreeform: false, allowComment: false }] },
    { signal: new AbortController().signal } as never)
    : prewalk.host.review({} as never, '# Complete plan\n\nImplement and verify.');
  cleanup.push(async () => { reply({ state: 'cancelled', reason: 'abort' }); await work; await prewalk.dispose(); });
  expect(form.hint).toBeDefined();
  const interaction = parseInteraction({ id: 'hinted', state: 'waiting', createdAt: Date.now(),
    scope: { kind: 'session', root: 'session', session: 'session' }, request: { kind: 'form', form } });
  const expected = feature === 'ask-user'
    ? { kind: 'form', actionId: 'submit', outcome: 'submit', values: { 'q1.selection': 'option1' } }
    : { kind: 'form', actionId: 'approve', outcome: 'submit', values: {} };

  const terminal = await wire(); terminal.state({ interactions: [interaction] });
  const client = terminal.createClient({ target: { kind: 'isolated', directory: terminal.directory, namespaceId: 'ignored' }, kind: 'tui',
    clientVersion: 'fixture', interactionKinds: [...TERMINAL_INTERACTION_KINDS], capabilities: [...TERMINAL_UI_CAPABILITIES] });
  const controller = new TuiSessionController(client); cleanup.push(() => controller.dispose());
  const custom = vi.fn(async (factory: Parameters<InteractionPresenterUi['custom']>[0]) => {
    let result: unknown;
    const component = await factory({ terminal: { rows: 30 }, requestRender: vi.fn() } as never,
      { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
      { getKeys: () => [], matches: (data: string, key: string) => data === '\r' && ['tui.select.confirm', 'tui.input.submit'].includes(key) } as never,
      value => { result = value; });
    component.handleInput?.('\r'); return result;
  });
  const terminalUi = { custom, select: vi.fn(), notify: vi.fn(), onTerminalInput: vi.fn(() => () => {}) } as unknown as InteractionPresenterUi;
  const native = createTerminalPresenters(controller, terminalUi, { setEditorText: vi.fn(), settings: () => ({}) as never, toolPresentation: () => undefined });
  cleanup.push(() => native.dispose());
  const interactions = new TerminalInteractions(controller, native.presenters); cleanup.push(() => interactions.dispose());
  await controller.start({ cwd: terminal.directory, sessionId: 'session' });
  await vi.waitFor(() => expect(terminal.fake.requests.find(request => request.op === 'interaction.answer')?.params).toMatchObject({ answer: expected }));
  expect(custom).toHaveBeenCalledOnce(); expect(terminalUi.select).not.toHaveBeenCalled();

  const editor = await wire(); editor.state({ interactions: [interaction] });
  const registry = new AcpSessionRegistry({ createClient: editor.createClient }); cleanup.push(() => registry.dispose());
  registry.initialize({ elicitation: { form: {} } });
  const request = vi.fn().mockResolvedValueOnce({ action: 'accept', content: { choice: expected.actionId } })
    .mockResolvedValueOnce({ action: 'accept', content: expected.values });
  await registry.loadSession({ sessionId: 'session', cwd: editor.directory, mcpServers: [] },
    { request, notify: vi.fn(async () => {}) } as unknown as AgentContext);
  await vi.waitFor(() => expect(editor.fake.requests.find(request => request.op === 'interaction.answer')?.params).toMatchObject({ answer: expected }));
  expect(request).toHaveBeenCalledTimes(2);
  reply({ state: 'answered', answer: expected as Extract<UiRequestResult, { state: 'answered' }>['answer'] });
  expect(await work).toMatchObject(feature === 'ask-user'
    ? { status: 'answered', answers: [{ questionId: 'q1', response: { selections: ['First'] } }] }
    : { action: 'Approve plan' });
});
