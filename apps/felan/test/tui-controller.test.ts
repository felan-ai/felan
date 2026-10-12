import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { KeybindingsManager, TUI_KEYBINDINGS, TuiAltScreen, setKeybindings, stripTerminalSequences, visibleWidth, type ProgramStatus, type Terminal } from '@earendil-works/pi-tui';
import { SessionClient } from '../src/client/client.js';
import { TuiSessionController } from '../src/tui/controller.js';
import { runDaemonTerminal } from '../src/tui/run.js';
import { createCommandAutocomplete, submitTuiInput } from '../src/tui/commands.js';
import type { TuiDialogHost } from '../src/tui/dialogs.js';
import { DaemonConfiguration } from '../../daemon/src/daemon/configuration.js';
import { DaemonTuiPreferences } from '../../daemon/src/daemon/tui-preferences.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { gate, serverFixture } from '../../daemon/test/fixtures/server.js';

const cleanup: Array<() => Promise<void>> = [];
beforeAll(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));
afterEach(async () => { for (const finish of cleanup.splice(0).reverse()) await finish(); });

async function fixture(onStream?: () => Promise<void>) {
  const f = await serverFixture({ now: Date.now, ...(onStream ? { onStream } : {}) });
  const preferences = new DaemonTuiPreferences({ agentDir: f.owner.target.agentDir, assertCurrent: () => f.registry.assertAdmission() });
  const server = new SessionServer({ registry: f.registry, models: f.root.runtime.session.modelRuntime, version: 'fixture',
    preferences,
    configuration: new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.registry.assertAdmission() }) });
  await server.start();
  const controllers: TuiSessionController[] = [];
  cleanup.push(async () => { for (const controller of controllers) await controller.dispose(); server.close(); await f.dispose(); });
  function controller() {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      expected: f.owner.identity, clientVersion: 'fixture', kind: 'tui' });
    const controller = new TuiSessionController(client); controllers.push(controller); return controller;
  }
  return { ...f, server, controller, preferences };
}

it('attaches through the protocol and receives authoritative completed messages without a local runtime', async () => {
  const f = await fixture(); const controller = f.controller();
  await controller.start({ cwd: f.cwd, sessionId: f.root.sessionId });
  expect(controller.snapshot?.cwd).toBe(f.cwd);
  expect(await controller.submit('hello daemon')).toBe(true);
  await vi.waitFor(() => expect(controller.history.some(row => row.role === 'assistant')).toBe(true));
  expect(controller.history.find(row => row.role === 'user')?.content).toContainEqual({ type: 'text', text: 'hello daemon' });
  expect(controller.snapshot?.model).toEqual({ provider: 'offline', id: 'fixture' });
});

it('creates, switches and continues the most recent root through daemon operations', async () => {
  const f = await fixture(); const controller = f.controller();
  await controller.start({ cwd: f.cwd });
  const created = controller.sessionId!;
  expect(created).not.toBe(f.root.sessionId);
  await controller.attach(f.root.sessionId);
  expect(controller.client.getAttachment(created)).toBeUndefined();
  expect(f.registry.binding(created)).toBeDefined();
  const other = f.controller(); await other.start({ cwd: f.cwd, continueRecent: true });
  expect((await other.sessions(f.cwd)).map(row => row.session)).toContain(created);
  expect(other.sessionId).toBeDefined();
});

it('detaches one client without stopping an active run observed by another, while explicit cancellation stops it', async () => {
  const entered = gate(); const release = gate();
  cleanup.push(async () => release.resolve());
  const f = await fixture(async () => { entered.resolve(); await release.promise; });
  const first = f.controller(); const second = f.controller();
  try {
    await first.start({ cwd: f.cwd, sessionId: f.root.sessionId }); await second.start({ cwd: f.cwd, sessionId: f.root.sessionId });
    expect(await first.submit('continue after detach')).toBe(true); await entered.promise;
    await first.dispose();
    expect(f.store.session(f.root.sessionId).run.state).toBe('running');
    expect(second.snapshot?.run.state).toBe('running');
    const cancelling = second.cancel(); release.resolve();
    expect((await cancelling).outcome).toBe('accepted');
    await vi.waitFor(() => expect(second.snapshot?.run.state).toBe('idle'));
  } finally { release.resolve(); }
});

it('keeps close separate from detach and does not shut down the server', async () => {
  const f = await fixture(); const controller = f.controller();
  await controller.start({ cwd: f.cwd, sessionId: f.root.sessionId });
  await controller.closeSession();
  expect(controller.sessionId).toBeUndefined(); expect(f.store.session(f.root.sessionId).state).toBe('closed');
  expect((await controller.perform('host.status', {})).outcome).toBe('accepted');
});

it('preserves an existing attachment when another selection is rejected', async () => {
  const f = await fixture(); const controller = f.controller();
  await controller.start({ cwd: f.cwd, sessionId: f.root.sessionId });
  await expect(controller.attach('missing-session')).rejects.toThrow();
  expect(controller.sessionId).toBe(f.root.sessionId); expect(controller.client.getAttachment(f.root.sessionId)).toBeDefined();
});

it('does not silently apply or discard new extension paths when attaching an existing session', async () => {
  const f = await fixture(); const controller = f.controller();
  await expect(controller.start({ cwd: f.cwd, sessionId: f.root.sessionId, extensions: ['/untrusted/new-extension.ts'] })).rejects.toThrow('cannot replace');
  expect(controller.sessionId).toBeUndefined(); expect(f.store.session(f.root.sessionId).state).toBe('open');
});

it('renders the real protocol session, resizes and restores the terminal on client exit without closing the session', async () => {
  const f = await fixture(); const controller = f.controller(); const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal); const signal = new AbortController();
  const running = runDaemonTerminal(controller, { cwd: f.cwd, sessionId: f.root.sessionId, initialMessage: 'terminal input',
    terminal, createTui: () => tui, signal: signal.signal });
  try {
    await vi.waitFor(() => expect(controller.history.some(row => row.role === 'assistant')).toBe(true));
    terminal.columns = 36; terminal.resize(); tui.renderNow(true);
    expect(tui.getScreenLines().every(line => visibleWidth(line) <= 36)).toBe(true);
    expect(tui.getScreenLines().join('\n')).toContain('Felan');
    terminal.input('\x04'); await running;
    expect(terminal.active).toBe(false); expect(f.store.session(f.root.sessionId).state).toBe('open');
  } finally { signal.abort(); await running; }
});

it('allows terminal exit during an unresolved connection and releases the connection deadline', async () => {
  const f = await fixture(); const terminal = new TestTerminal();
  const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
    expected: f.owner.identity, clientVersion: 'fixture', kind: 'tui', connector: () => new Promise(() => {}) });
  const controller = new TuiSessionController(client); const signal = new AbortController();
  const running = runDaemonTerminal(controller, { cwd: f.cwd, terminal, signal: signal.signal });
  try {
    expect(terminal.active).toBe(true); terminal.input('\x04'); await running;
    expect(client.status).toBe('closed'); expect(terminal.active).toBe(false);
  } finally { signal.abort(); await running; }
});

it('keeps an editor draft when the model shortcut opens and cancels its selector', async () => {
  const f = await fixture(); const controller = f.controller(); const terminal = new TestTerminal(); const tui = new TuiAltScreen(terminal);
  const signal = new AbortController(); const running = runDaemonTerminal(controller, { cwd: f.cwd, sessionId: f.root.sessionId, terminal, createTui: () => tui, signal: signal.signal });
  try {
    await vi.waitFor(() => expect(controller.state?.status).toBe('live'));
    const before = f.root.runtime.session.messages.length;
    terminal.input('unsubmitted draft'); terminal.input('\x0c');
    await vi.waitFor(() => expect(tui.hasOverlay()).toBe(true));
    terminal.input('\x1b'); await vi.waitFor(() => expect(tui.hasOverlay()).toBe(false));
    tui.renderNow(true); expect(tui.getScreenLines().join('\n')).toContain('unsubmitted draft');
    expect(f.root.runtime.session.messages).toHaveLength(before);
    terminal.input('\x03'); terminal.input('\x04'); await running;
  } finally { signal.abort(); await running; }
});

it('loads daemon preferences without replacing input typed during startup', async () => {
  const f = await fixture(); const controller = f.controller(); const terminal = new TestTerminal(); const tui = new TuiAltScreen(terminal);
  const entered = gate(); const release = gate(); const get = f.preferences.get.bind(f.preferences);
  vi.spyOn(f.preferences, 'get').mockImplementation(async () => { entered.resolve(); await release.promise; return get(); });
  const signal = new AbortController();
  const running = runDaemonTerminal(controller, { cwd: f.cwd, sessionId: f.root.sessionId, initialDraft: 'initial draft', terminal, createTui: () => tui, signal: signal.signal });
  try {
    expect(terminal.active).toBe(true); await entered.promise;
    terminal.input(' plus typed text'); release.resolve();
    await vi.waitFor(() => expect(controller.state?.status).toBe('live'));
    tui.renderNow(true); expect(tui.getScreenLines().join('\n')).toContain('initial draft plus typed text');
    expect(f.root.runtime.session.messages).toHaveLength(0);
  } finally { release.resolve(); signal.abort(); await running; }
});

it('exits while a daemon preference request remains unresolved', async () => {
  const f = await fixture(); const controller = f.controller(); const terminal = new TestTerminal();
  const entered = gate(); const release = gate(); const get = f.preferences.get.bind(f.preferences);
  vi.spyOn(f.preferences, 'get').mockImplementation(async () => { entered.resolve(); await release.promise; return get(); });
  const signal = new AbortController(); const running = runDaemonTerminal(controller, { cwd: f.cwd, terminal, signal: signal.signal });
  try {
    await entered.promise; terminal.input('\x04'); await running;
    expect(terminal.active).toBe(false); expect(controller.client.status).toBe('closed');
    expect(controller.sessionId).toBeUndefined();
  } finally { release.resolve(); signal.abort(); await running; }
});

it('uses daemon shortcuts in the active terminal and preserves a rejected settings draft', async () => {
  const f = await fixture(); await f.preferences.set({ keybindings: { 'app.exit': 'alt+x', 'app.model.select': 'alt+m' } });
  const controller = f.controller(); const terminal = new TestTerminal(); const tui = new TuiAltScreen(terminal);
  const signal = new AbortController(); const running = runDaemonTerminal(controller, { cwd: f.cwd, sessionId: f.root.sessionId, terminal, createTui: () => tui, signal: signal.signal });
  try {
    await vi.waitFor(() => expect(controller.state?.status).toBe('live'));
    terminal.input('retained draft'); terminal.input('\x1bm');
    await vi.waitFor(() => expect(tui.hasOverlay()).toBe(true));
    terminal.input('\x1b'); await vi.waitFor(() => expect(tui.hasOverlay()).toBe(false));
    tui.renderNow(true); expect(tui.getScreenLines().join('\n')).toContain('retained draft');
    terminal.input('\x03');
    vi.spyOn(f.preferences, 'set').mockRejectedValueOnce(new Error('cannot write preferences'));
    terminal.input('/settings'); terminal.input('\r');
    await vi.waitFor(() => expect(tui.hasOverlay()).toBe(true));
    terminal.input('Thinking'); terminal.input('\r');
    await vi.waitFor(() => { tui.renderNow(true); expect(tui.getScreenLines().join('\n')).toContain('Thinking: hidden'); });
    terminal.input('Save changes'); terminal.input('\r');
    await vi.waitFor(() => {
      expect(controller.notice).toBe('Outcome uncertain: Operation did not complete. Inspect the current session before retrying.');
      tui.renderNow(true);
      const visible = stripTerminalSequences(tui.getScreenLines().join('\n'));
      expect(visible).toContain('Outcome uncertain: Operation did not complete.');
      expect(visible).toContain('Thinking: hidden');
    });
    terminal.input('\x1b'); await vi.waitFor(() => expect(tui.hasOverlay()).toBe(false));
    tui.renderNow(true); expect(tui.getScreenLines().join('\n')).toContain('/settings');
    expect((await f.preferences.get()).hideThinking).toBe(false);
    terminal.input('\x03'); terminal.input('\x04'); expect(terminal.active).toBe(true);
    terminal.input('\x1bx'); await running; expect(terminal.active).toBe(false);
  } finally { signal.abort(); await running; }
});

it('routes settings locally without requiring an attached session', async () => {
  const f = await fixture(); const controller = f.controller(); const preferences = vi.fn(async () => true);
  expect(await submitTuiInput(controller, fakeDialogs(), '/settings', { cwd: f.cwd, exit: vi.fn(), preferences })).toBe(true);
  expect(preferences).toHaveBeenCalledOnce(); expect(controller.sessionId).toBeUndefined();
  await expect(submitTuiInput(controller, fakeDialogs(), '/settings unexpected', { cwd: f.cwd, exit: vi.fn(), preferences })).rejects.toThrow('Usage: /settings');
});

it('routes login and dependency commands locally without attaching or adding credentials to model input', async () => {
  const f = await fixture(); const controller = f.controller(); const login = vi.fn(async () => true); const dependencies = vi.fn(async () => false);
  const options = { cwd: f.cwd, exit: vi.fn(), login, dependencies };
  expect(await submitTuiInput(controller, fakeDialogs(), '/login', options)).toBe(true);
  expect(await submitTuiInput(controller, fakeDialogs(), '/dependencies', options)).toBe(false);
  expect(login).toHaveBeenCalledOnce(); expect(dependencies).toHaveBeenCalledOnce(); expect(controller.sessionId).toBeUndefined();
  await expect(submitTuiInput(controller, fakeDialogs(), '/login secret-in-command', options)).rejects.toThrow('Usage: /login');
  expect(login).toHaveBeenCalledOnce();
  const completions = await createCommandAutocomplete(controller).getSuggestions(['/dep'], 0, 4, { signal: new AbortController().signal });
  expect(completions?.items).toContainEqual({ value: '/dependencies ', label: '/dependencies' });
});

it('routes model, thinking and rename through advertised commands, preserving argument whitespace', async () => {
  const f = await fixture(); const controller = f.controller(); await controller.start({ cwd: f.cwd, sessionId: f.root.sessionId });
  const dialogs = fakeDialogs(); const options = { cwd: f.cwd, exit: vi.fn() };
  const request = vi.spyOn(controller, 'perform');
  expect(await submitTuiInput(controller, dialogs, '/rename Name  with\nline', options)).toBe(true);
  expect(request).toHaveBeenCalledWith('session.rename', { name: 'Name  with\nline' }, f.root.sessionId);
  expect(controller.snapshot?.title).toBe('Name  with line');
  expect(await submitTuiInput(controller, dialogs, '/model offline/fixture', options)).toBe(true);
  expect(await submitTuiInput(controller, dialogs, '/thinking off', options)).toBe(true);
  await expect(submitTuiInput(controller, dialogs, '/model missing/model', options)).rejects.toThrow('advertised');
});

it('requires confirmation to close and treats exit as a client-only action', async () => {
  const f = await fixture(); const controller = f.controller(); await controller.start({ cwd: f.cwd, sessionId: f.root.sessionId });
  const dialogs = fakeDialogs(); const exit = vi.fn();
  expect(await submitTuiInput(controller, dialogs, '/close', { cwd: f.cwd, exit })).toBe(false);
  expect(f.store.session(f.root.sessionId).state).toBe('open');
  expect(await submitTuiInput(controller, dialogs, '/exit', { cwd: f.cwd, exit })).toBe(true);
  expect(exit).toHaveBeenCalledOnce(); expect(f.store.session(f.root.sessionId).state).toBe('open');
  dialogs.confirm = async () => true;
  expect(await submitTuiInput(controller, dialogs, '/close', { cwd: f.cwd, exit })).toBe(true);
  expect(f.store.session(f.root.sessionId).state).toBe('closed');
});

it('forks before a selected zero-based user position without resubmitting that message', async () => {
  const f = await fixture(); const controller = f.controller(); await controller.start({ cwd: f.cwd, sessionId: f.root.sessionId });
  await controller.submit('original prompt'); await vi.waitFor(() => expect(controller.snapshot?.run.state).toBe('idle'));
  expect(await submitTuiInput(controller, fakeDialogs(), '/fork 0', { cwd: f.cwd, exit: vi.fn() })).toBe(true);
  expect(controller.sessionId).not.toBe(f.root.sessionId);
  expect(controller.history.some(message => JSON.stringify(message.content).includes('original prompt'))).toBe(false);
});

it('selects a stored user entry for fork and restores its full known text to the editor', async () => {
  const f = await fixture(); const controller = f.controller(); await controller.start({ cwd: f.cwd, sessionId: f.root.sessionId });
  await controller.submit('first prompt'); await vi.waitFor(() => expect(controller.snapshot?.run.state).toBe('idle'));
  await controller.submit('second\nfull prompt'); await vi.waitFor(() => expect(controller.snapshot?.run.state).toBe('idle'));
  const users = (await controller.tree()).entries.filter(entry => entry.role === 'user');
  expect(users).toHaveLength(2);
  const dialogs = fakeDialogs(); dialogs.select = vi.fn(async () => users[1]!.id); const setDraft = vi.fn();
  expect(await submitTuiInput(controller, dialogs, '/fork', { cwd: f.cwd, exit: vi.fn(), setDraft })).toBe(true);
  expect(setDraft).toHaveBeenCalledWith('second\nfull prompt');
  expect(controller.history.some(message => JSON.stringify(message.content).includes('first prompt'))).toBe(true);
  expect(controller.history.some(message => JSON.stringify(message.content).includes('second'))).toBe(false);
});

it('serializes concurrent attachment selection and releases superseded root bindings', async () => {
  const f = await fixture(); const controller = f.controller(); await controller.start({ cwd: f.cwd, sessionId: f.root.sessionId });
  const a = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  const entered = gate(); const release = gate(); const attach = f.registry.attach.bind(f.registry);
  vi.spyOn(f.registry, 'attach').mockImplementation(async (id, options) => {
    if (id === a.sessionId) { entered.resolve(); await release.promise; }
    return attach(id, options);
  });
  const first = controller.attach(a.sessionId); await entered.promise; const second = controller.attach(b.sessionId);
  try { expect(controller.client.getAttachment(b.sessionId)).toBeUndefined(); }
  finally { release.resolve(); await Promise.all([first, second]); }
  expect(controller.sessionId).toBe(b.sessionId);
  expect(controller.client.getAttachment(a.sessionId)).toBeUndefined(); expect(controller.client.getAttachment(f.root.sessionId)).toBeUndefined();
});

it('does not clear a newly selected session when an older close finishes', async () => {
  const f = await fixture(); const controller = f.controller(); await controller.start({ cwd: f.cwd, sessionId: f.root.sessionId });
  const next = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  const entered = gate(); const release = gate(); const close = f.registry.closeAdmitted.bind(f.registry);
  vi.spyOn(f.registry, 'closeAdmitted').mockImplementation(async (request, session) => { entered.resolve(); await release.promise; return close(request, session); });
  const closing = controller.closeSession(); await entered.promise;
  try { await controller.attach(next.sessionId); }
  finally { release.resolve(); await closing; }
  expect(controller.sessionId).toBe(next.sessionId); expect(controller.client.getAttachment(next.sessionId)).toBeDefined();
});

it('keeps the queue read-only and rejects unavailable commands instead of sending them as prompts', async () => {
  const f = await fixture(); const controller = f.controller(); await controller.start({ cwd: f.cwd, sessionId: f.root.sessionId });
  const dialogs = fakeDialogs(); const before = f.root.runtime.session.messages.length;
  await submitTuiInput(controller, dialogs, '/queue', { cwd: f.cwd, exit: vi.fn() });
  await expect(submitTuiInput(controller, dialogs, '/unknown', { cwd: f.cwd, exit: vi.fn() })).rejects.toThrow('unavailable');
  expect(f.root.runtime.session.messages).toHaveLength(before);
  expect(dialogs.select).toHaveBeenCalledWith(expect.stringContaining('read-only'), []);
});

it('changes cwd by creating another session instead of mutating the existing session', async () => {
  const f = await fixture(); const controller = f.controller(); await controller.start({ cwd: f.cwd, sessionId: f.root.sessionId });
  expect(await submitTuiInput(controller, fakeDialogs(), '/cwd .', { cwd: f.cwd, exit: vi.fn() })).toBe(true);
  expect(controller.sessionId).not.toBe(f.root.sessionId); expect(controller.snapshot?.cwd).toBe(f.cwd);
  expect(f.store.session(f.root.sessionId).state).toBe('open');
});

it('requires separate daemon and force confirmations before global lifecycle actions', async () => {
  const f = await fixture(); const controller = f.controller(); await controller.start({ cwd: f.cwd, sessionId: f.root.sessionId });
  const dialogs = fakeDialogs(); const daemon = vi.fn(async () => {});
  dialogs.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await submitTuiInput(controller, dialogs, '/daemon stop force', { cwd: f.cwd, exit: vi.fn(), daemon })).toBe(false);
  expect(daemon).not.toHaveBeenCalled();
  dialogs.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
  expect(await submitTuiInput(controller, dialogs, '/daemon restart force', { cwd: f.cwd, exit: vi.fn(), daemon })).toBe(true);
  expect(daemon).toHaveBeenCalledOnce(); expect(daemon).toHaveBeenCalledWith('restart', true);
});

it('reads daemon status without turning the command into model input', async () => {
  const f = await fixture(); const controller = f.controller(); await controller.start({ cwd: f.cwd, sessionId: f.root.sessionId });
  const dialogs = fakeDialogs(); const count = f.root.runtime.session.messages.length;
  expect(await submitTuiInput(controller, dialogs, '/daemon status', { cwd: f.cwd, exit: vi.fn() })).toBe(true);
  expect(dialogs.select).toHaveBeenCalledWith(expect.stringContaining('Daemon'), expect.arrayContaining([expect.objectContaining({ value: 'summary' })]));
  expect(f.root.runtime.session.messages).toHaveLength(count);
});

it('offers command completion from client commands without accessing workspace files', async () => {
  const f = await fixture(); const controller = f.controller(); await controller.start({ cwd: f.cwd, sessionId: f.root.sessionId });
  const provider = createCommandAutocomplete(controller);
  const result = await provider.getSuggestions(['/mo'], 0, 3, { signal: new AbortController().signal });
  expect(result?.items).toContainEqual({ value: '/model ', label: '/model' });
  expect(provider.applyCompletion(['/mo'], 0, 3, result!.items[0]!, result!.prefix)).toEqual({ lines: ['/model '], cursorLine: 0, cursorCol: 7 });
});

function fakeDialogs(): TuiDialogHost {
  return { select: vi.fn(async () => undefined), input: vi.fn(async () => undefined), confirm: vi.fn(async () => false) };
}

class TestTerminal implements Terminal {
  columns = 90;
  rows = 22;
  kittyProtocolActive = false;
  active = false;
  input: (data: string) => void = () => {};
  resize: () => void = () => {};
  start(input: (data: string) => void, resize: () => void): void { this.active = true; this.input = input; this.resize = resize; }
  stop(): void { this.active = false; }
  async drainInput(): Promise<void> {}
  write(_data: string): void {}
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
