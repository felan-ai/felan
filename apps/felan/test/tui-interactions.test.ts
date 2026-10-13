import { afterEach, expect, it, vi } from 'vitest';
import { stripTerminalSequences, TuiAltScreen, type ProgramStatus, type Terminal } from '@earendil-works/pi-tui';
import { createRegistryInteractionBroker } from '../../daemon/src/daemon/broker.js';
import { createSessionExtensionUi } from '../../daemon/src/daemon/extension-ui.js';
import { sessionUiPort } from './session-ui-fixture.js';
import { createUiAskUserHost } from '../../../packages/ext-ask-user/src/ui.js';
import { createPrewalkUiHost } from '../../../packages/ext-prewalk/src/ui.js';
import type { ExtensionContext } from '@felan-ai/agent-core';
import { DaemonConfiguration } from '../src/providers/configuration.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';
import { SessionClient } from '../src/client/client.js';
import { TuiSessionController } from '../src/tui/controller.js';
import { TERMINAL_INTERACTION_KINDS, TERMINAL_UI_CAPABILITIES } from '../src/tui/interactions.js';
import { runDaemonTerminal } from '../src/tui/run.js';
import { bundledClientThemes, themedClientTerminal, themeName } from '../src/tui/theme.js';
import { APPROVE_PLAN_OPTION } from '../src/tui/renderers/prewalk.js';
import type { UiView } from '@felan-ai/session-protocol';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

function screenText(tui: TuiAltScreen): string {
  tui.renderNow(true);
  return stripTerminalSequences(tui.getScreenLines().join('\n'));
}

async function fixture() {
  const f = await serverFixture({ now: Date.now }); const broker = createRegistryInteractionBroker(f.registry, {  });
  const server = new SessionServer({ registry: f.registry, models: f.root.runtime.session.modelRuntime, version: 'fixture', broker,
    configuration: new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.owner.assertCurrent() }) });
  await server.start();
  cleanup.push(async () => { server.close(); await broker.drain(); await f.dispose(); });
  function client() { return new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
    clientVersion: 'fixture', kind: 'tui', interactionKinds: [...TERMINAL_INTERACTION_KINDS], capabilities: [...TERMINAL_UI_CAPABILITIES] }); }
  async function terminal() {
    const transport = client(); const controller = new TuiSessionController(transport); const terminal = new TestTerminal(); const tui = new TuiAltScreen(terminal);
    const signal = new AbortController(); const running = runDaemonTerminal(controller, { cwd: f.cwd, sessionId: f.root.sessionId,
      terminal, createTui: () => tui, signal: signal.signal });
    cleanup.push(async () => { signal.abort(); await running; });
    await vi.waitFor(() => expect(controller.state?.status).toBe('live'));
    return { transport, controller, terminal, tui, signal, running };
  }
  return { ...f, broker, client, terminal, scope: { kind: 'session' as const, session: f.root.sessionId, root: f.root.sessionId } };
}

it('uses real light and dark theme objects from bounded installed assets', () => {
  const themes = bundledClientThemes();
  expect(themes.get('light')?.appearance).toBe('light');
  expect(themes.get('dark')?.appearance).toBe('dark');
  expect(() => themeName('../untrusted')).toThrow();
});

it('paints terminal clears and resets with client colors and restores terminal defaults on stop', () => {
  const terminal = new TestTerminal(); const themes = bundledClientThemes(); let theme = themes.get('felan-dark')!;
  const wrapped = themedClientTerminal(terminal, () => theme);
  wrapped.write('\x1b[2Jbefore\x1b[0mafter');
  expect(terminal.output).toContain(theme.getBgAnsi('customMessageBg'));
  expect(terminal.output.indexOf(theme.getBgAnsi('customMessageBg'))).toBeLessThan(terminal.output.indexOf('\x1b[2J'));
  expect(terminal.output).toContain(theme.getFgAnsi('text'));
  expect(terminal.output.lastIndexOf(theme.getBgAnsi('customMessageBg'))).toBeLessThan(terminal.output.indexOf('after'));
  const offset = terminal.output.length; theme = themes.get('felan-light')!; wrapped.write('light');
  expect(terminal.output.slice(offset)).toContain(theme.getBgAnsi('customMessageBg'));
  expect(terminal.output.slice(offset)).toContain(theme.getFgAnsi('text'));
  expect(terminal.output).not.toContain('\x1b]11;');
  const stop = vi.spyOn(terminal, 'stop'); wrapped.stop();
  expect(stop).toHaveBeenCalledOnce(); expect(terminal.output.endsWith('\x1b[0m')).toBe(true);
});

it('presents an input interaction and commits only the entered protocol answer', async () => {
  const f = await fixture(); const view = await f.terminal();
  const pending = f.broker.request({ kind: 'input', title: 'Enter a value' }, f.scope);
  await vi.waitFor(() => expect(screenText(view.tui)).toContain('Enter a value'));
  expect(view.tui.hasOverlay()).toBe(false);
  view.terminal.input('chosen'); view.terminal.input('\r');
  expect(await pending).toEqual({ state: 'answered', answer: { kind: 'input', text: 'chosen' } });
  expect(f.store.snapshot().interactions.at(-1)?.state).toBe('answered');
});

it('retains a pending question when the terminal disconnects and presents it after reattachment', async () => {
  const f = await fixture(); const first = await f.terminal();
  const pending = f.broker.request({ kind: 'input', title: 'Still pending' }, f.scope);
  await vi.waitFor(() => expect(screenText(first.tui)).toContain('Still pending')); first.signal.abort(); await first.running;
  expect(f.broker.pending()).toHaveLength(1);
  const second = await f.terminal(); await vi.waitFor(() => expect(screenText(second.tui)).toContain('Still pending'));
  second.terminal.input('after reconnect'); second.terminal.input('\r');
  expect(await pending).toMatchObject({ state: 'answered', answer: { text: 'after reconnect' } });
});

it('keeps a question draft during snapshot recovery and waits to validate its answer', async () => {
  const f = await fixture(); const view = await f.terminal();
  const pending = f.broker.request({ kind: 'input', title: 'Recovery question' }, f.scope);
  await vi.waitFor(() => expect(screenText(view.tui)).toContain('Recovery question'));
  view.terminal.input('kept');
  const getAttachment = view.transport.getAttachment.bind(view.transport);
  let recovering = true;
  const lookup = vi.spyOn(view.transport, 'getAttachment').mockImplementation(session => {
    const attachment = getAttachment(session);
    return attachment && recovering ? { ...attachment, state: { ...attachment.state, status: 'recovering' } } : attachment;
  });
  try {
    view.controller.setNotice('Recovering snapshot');
    expect(screenText(view.tui)).toContain('Recovery question');
    view.terminal.input('-answer'); view.terminal.input('\r');
    await vi.waitFor(() => expect(screenText(view.tui)).not.toContain('Recovery question'));
    expect(f.broker.pending()).toHaveLength(1);
    expect(f.store.snapshot().requests.filter(row => row.op === 'interaction.answer')).toHaveLength(0);
    recovering = false; view.controller.setNotice('Snapshot restored');
    expect(await pending).toMatchObject({ state: 'answered', answer: { text: 'kept-answer' } });
  } finally { lookup.mockRestore(); }
});

it('does not submit a held recovery answer after another client wins', async () => {
  const f = await fixture(); const view = await f.terminal();
  const pending = f.broker.request({ kind: 'input', title: 'Recovering winner' }, f.scope);
  await vi.waitFor(() => expect(screenText(view.tui)).toContain('Recovering winner'));
  const getAttachment = view.transport.getAttachment.bind(view.transport);
  let recovering = true;
  const lookup = vi.spyOn(view.transport, 'getAttachment').mockImplementation(session => {
    const attachment = getAttachment(session);
    return attachment && recovering ? { ...attachment, state: { ...attachment.state, status: 'recovering' } } : attachment;
  });
  try {
    view.controller.setNotice('Recovering snapshot');
    view.terminal.input('must not submit'); view.terminal.input('\r');
    await vi.waitFor(() => expect(screenText(view.tui)).not.toContain('Recovering winner'));
    const other = f.client(); cleanup.push(async () => other.close()); await other.connect(); await other.attach(f.root.sessionId);
    const interaction = f.broker.pending()[0]!;
    await other.request('interaction.answer', { interactionId: interaction.id, answer: { kind: 'input', text: 'other client' } }, { session: f.root.sessionId });
    expect(await pending).toMatchObject({ state: 'answered', answer: { text: 'other client' } });
    await vi.waitFor(() => expect(getAttachment(f.root.sessionId)?.state.snapshot?.interactions.find(item => item.id === interaction.id)?.state).toBe('answered'));
    recovering = false; view.controller.setNotice('Snapshot restored');
    view.signal.abort(); await view.running;
    expect(f.store.snapshot().requests.filter(row => row.op === 'interaction.answer')).toHaveLength(1);
  } finally { lookup.mockRestore(); }
});

it('closes a stale dialog when another client wins without submitting a second answer', async () => {
  const f = await fixture(); const first = await f.terminal();
  const pending = f.broker.request({ kind: 'input', title: 'One winner' }, f.scope);
  await vi.waitFor(() => expect(screenText(first.tui)).toContain('One winner'));
  const other = f.client(); cleanup.push(async () => other.close()); await other.connect(); await other.attach(f.root.sessionId);
  const interaction = f.broker.pending()[0]!;
  expect((await other.request('interaction.answer', { interactionId: interaction.id, answer: { kind: 'input', text: 'other client' } }, { session: f.root.sessionId })).outcome).toBe('accepted');
  await pending; await vi.waitFor(() => expect(screenText(first.tui)).not.toContain('One winner'));
  expect(f.store.snapshot().requests.filter(row => row.op === 'interaction.answer')).toHaveLength(1);
});

it('runs the actual multi-page ask-user wizard with public TUI presentation primitives', async () => {
  const f = await fixture(); const view = await f.terminal();
  const ui = createSessionExtensionUi({ port: sessionUiPort(f.broker, f.scope) }); ui.activate(() => {});
  cleanup.push(async () => { await ui.vocabulary.dispose(); ui.dispose(); });
  const host = createUiAskUserHost(ui.vocabulary.createExtensionUi('@felan-ai/ext-ask-user'));
  const pending = host.ask({ questions: ['first', 'second'].map(id => ({ id, question: `Choose ${id}`, header: id, allowMultiple: false, allowFreeform: false, allowComment: false,
    options: [{ title: 'Alpha' }, { title: 'Beta' }] })) }, { signal: new AbortController().signal });
  await vi.waitFor(() => expect(screenText(view.tui)).toContain('Choose first'));
  expect(view.tui.hasOverlay()).toBe(false);
  view.terminal.input('\r'); view.terminal.input('\r'); view.terminal.input('\r');
  expect(await pending).toMatchObject({ status: 'answered', answers: [
    { questionId: 'first', response: { kind: 'selection', selections: ['Alpha'] } }, { questionId: 'second', response: { kind: 'selection', selections: ['Alpha'] } },
  ] });
});

it('renders Prewalk through its generic form hint', async () => {
  const f = await fixture(); const view = await f.terminal();
  const ui = createSessionExtensionUi({ port: sessionUiPort(f.broker, f.scope) }); ui.activate(() => {});
  const review = createPrewalkUiHost(ui.vocabulary.createExtensionUi('@felan-ai/ext-prewalk'));
  cleanup.push(async () => { await review.dispose(); await ui.vocabulary.dispose(); ui.dispose(); });
  const pending = review.host.review({} as ExtensionContext, '# Review this plan');
  await vi.waitFor(() => expect(view.tui.hasOverlay()).toBe(true));
  view.terminal.input('\r');
  expect(await pending).toMatchObject({ action: APPROVE_PLAN_OPTION });
});

it('renders daemon-owned status and powerline data and follows terminal resize', async () => {
  const f = await fixture(); const view = await f.terminal();
  f.registry.projection(f.root.sessionId).setPresentation({ id: 'status-fixture', kind: 'status', key: 'fixture', value: { kind: 'text', text: 'Index ready' }, fallback: 'Status' });
  f.registry.projection(f.root.sessionId).setPresentation({ id: 'footer-view', kind: 'view', revision: 1, title: 'Powerline',
    hint: { id: 'felan.powerline', version: '2.0.0' }, fields: [
      { id: 'line', label: 'Line', valueKind: 'number' }, { id: 'segment', label: 'Segment', valueKind: 'text' },
      { id: 'text', label: 'Value', valueKind: 'text' }, { id: 'alignment', label: 'Alignment', valueKind: 'text' }, { id: 'color', label: 'Color', valueKind: 'text' }],
    items: [...Object.entries({ style: 'minimal', charset: 'text', autoWrap: 'true', padding: '0', lines: '1' }).map(([key, text]) => ({
      id: `display-${key}`, values: { line: 0, segment: `display.${key}`, text, alignment: '', color: '' }, fallback: key,
    })), { id: 'line-0-segment-0', values: { line: 1, segment: 'directory', text: 'Projected footer', alignment: 'left', color: 'directory' }, fallback: 'Directory' }],
    actions: [], fallback: 'Powerline data' });
  await vi.waitFor(() => expect(view.terminal.output).toContain('Projected footer'));
  expect(view.terminal.output).toContain('Index ready');
  view.terminal.output = ''; view.terminal.columns = 45; view.terminal.rows = 16; view.terminal.resize();
  await vi.waitFor(() => expect(view.terminal.output).toContain('Projected footer'));
  expect(view.controller.state?.status).toBe('live');
});

it('opens the scoped agent navigator without constructing an execution host in the client', async () => {
  const f = await fixture(); const view = await f.terminal();
  view.terminal.input('/agents'); view.terminal.input('\r');
  await vi.waitFor(() => expect(view.tui.hasOverlay()).toBe(true));
  expect(view.tui.hasOverlay()).toBe(true);
  view.terminal.input('\x1b');
  await vi.waitFor(() => expect(view.tui.hasOverlay()).toBe(false));
  expect(f.registry.binding(f.root.sessionId)).toBeDefined();
});

it('keeps Escape scoped to a question above the agent navigator', async () => {
  const f = await fixture(); const view = await f.terminal();
  view.terminal.input('/agents'); view.terminal.input('\r');
  await vi.waitFor(() => expect(view.tui.hasOverlay()).toBe(true));
  const question = f.broker.request({ kind: 'input', title: 'Question above navigator' }, f.scope);
  await vi.waitFor(() => expect(view.terminal.output).toContain('Question above navigator'));
  view.terminal.input('\x1b');
  expect(await question).toMatchObject({ state: 'cancelled', reason: 'user' });
  expect(view.tui.hasOverlay()).toBe(true);
  view.terminal.input('\x1b');
  await vi.waitFor(() => expect(view.tui.hasOverlay()).toBe(false));
});

it('hides malformed powerline data without losing the terminal and accepts a later valid frame', async () => {
  const f = await fixture(); const view = await f.terminal();
  const footer: UiView = { id: 'footer-recovery', kind: 'view', revision: 1, title: 'Powerline',
    hint: { id: 'felan.powerline', version: '2.0.0' }, fields: [
      { id: 'line', label: 'Line', valueKind: 'number' }, { id: 'segment', label: 'Segment', valueKind: 'text' },
      { id: 'text', label: 'Value', valueKind: 'text' }, { id: 'alignment', label: 'Alignment', valueKind: 'text' }, { id: 'color', label: 'Color', valueKind: 'text' }],
    items: [...Object.entries({ style: 'minimal', charset: 'text', autoWrap: 'true', padding: '0', lines: '1' }).map(([key, text]) => ({
      id: `display-${key}`, values: { line: 0, segment: `display.${key}`, text, alignment: '', color: '' }, fallback: key,
    })), { id: 'line-0-segment-0', values: { line: 1, segment: 'directory', text: 'Recovered footer', alignment: 'left', color: 'directory' }, fallback: 'Directory' }],
    actions: [], fallback: 'Powerline data' };
  f.registry.projection(f.root.sessionId).setPresentation({ ...footer, items: footer.items.map(item => item.id === 'line-0-segment-0'
    ? { ...item, values: { ...item.values, color: 'untrusted-color' } } : item) });
  await vi.waitFor(() => expect(view.controller.notice).toContain('invalid powerline data'));
  expect(view.controller.state?.status).toBe('live');
  expect(view.terminal.output).not.toContain('Recovered footer');
  f.registry.projection(f.root.sessionId).setPresentation({ ...footer, revision: 2 });
  await vi.waitFor(() => expect(view.terminal.output).toContain('Recovered footer'));
});

class TestTerminal implements Terminal {
  columns = 100; rows = 28; kittyProtocolActive = false;
  input: (data: string) => void = () => {};
  resize: () => void = () => {};
  output = '';
  start(input: (data: string) => void, resize: () => void): void { this.input = input; this.resize = resize; }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(text: string): void { this.output += text; }
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  setProgramStatus(_status: ProgramStatus): void {}
}

