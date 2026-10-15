import { configField, defineExtensionConfig, type ExtensionConfigDefinition } from '@felan-ai/agent-core';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { KeybindingsManager, TUI_KEYBINDINGS, TuiAltScreen, setKeybindings, stripTerminalSequences, visibleWidth, type ProgramStatus, type Terminal } from '@earendil-works/pi-tui';
import { SessionClient } from '../src/client/client.js';
import { TuiSessionController } from '../src/tui/controller.js';
import { runDaemonTerminal } from '../src/tui/run.js';
import { HerdrPane, type HerdrRequest } from '../src/tui/herdr.js';
import { createCommandAutocomplete, submitTuiInput } from '../src/tui/commands.js';
import type { TuiDialogHost } from '../src/tui/dialogs.js';
import { ClientPreferencesStore } from '../src/tui/preferences-store.js';
import { DaemonConfiguration } from '../src/providers/configuration.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { gate, serverFixture } from '../../daemon/test/fixtures/server.js';
import type { Message } from '@felan-ai/session-protocol';
import { snapshot } from './client-fixtures.js';

const cleanup: Array<() => Promise<void>> = [];
beforeAll(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));
afterEach(async () => { for (const finish of cleanup.splice(0).reverse()) await finish(); vi.restoreAllMocks(); });

function screenText(tui: TuiAltScreen): string {
  tui.renderNow(true);
  return stripTerminalSequences(tui.getScreenLines().join('\n'));
}

async function fixture(onStream?: () => Promise<void>, configDefinitions: readonly ExtensionConfigDefinition[] = []) {
  const f = await serverFixture({ now: Date.now, configDefinitions, ...(onStream ? { onStream } : {}) });
  const preferences = new ClientPreferencesStore(f.owner.target.agentDir);
  const server = new SessionServer({ registry: f.registry, models: f.root.runtime.session.modelRuntime, version: 'fixture',
    configuration: new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: configDefinitions, assertCurrent: () => f.registry.assertAdmission() }) });
  await server.start();
  const controllers: TuiSessionController[] = [];
  cleanup.push(async () => {
    for (const controller of controllers) await controller.dispose();
    server.close(); await server.settleCommands(); await f.dispose();
  });
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

it('reloads the attached session and confirms it like Pi', async () => {
  const f = await fixture(); const controller = f.controller();
  await controller.start({ cwd: f.cwd, sessionId: f.root.sessionId });
  expect(await controller.reloadSession(f.root.sessionId)).toBe(true);
  expect(controller.notice).toBe('Reloaded extensions, skills, prompts, themes, and context files.');
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

it('resumes an existing session and keeps its saved extensions when --extension is given', async () => {
  const f = await fixture(); const controller = f.controller();
  await controller.start({ cwd: f.cwd, sessionId: f.root.sessionId, extensions: ['/untrusted/new-extension.ts'] });
  expect(controller.sessionId).toBe(f.root.sessionId); expect(controller.notice).toContain('keep their saved extensions');
  expect(f.store.session(f.root.sessionId).profile?.extensionPaths).toBeUndefined();
});

it('resumes the first session matching an ambiguous ID prefix', async () => {
  const rows = ['abc-1', 'abc-2'].map(session => ({ session, root: session, cwd: '/fixture', title: '', revision: 1, state: 'open', residency: 'warm',
    lastActivity: 1, run: { state: 'idle' }, policy: { effective: 'host-default', generation: 0 } }));
  const attach = vi.fn(async () => ({ outcome: 'accepted' }));
  const client = { status: 'ready', capabilities: { operations: ['sessions.list'] }, connect: async () => {}, subscribe: () => () => {}, getAttachment: () => undefined,
    request: async () => ({ outcome: 'accepted', result: { entries: rows } }), attach, close() {} };
  const controller = new TuiSessionController(client as unknown as SessionClient);
  await controller.start({ cwd: '/fixture', sessionId: 'abc' });
  expect(attach).toHaveBeenCalledExactlyOnceWith('abc-1'); expect(controller.sessionId).toBe('abc-1');
});

it('explains a blocked attachment in the recovery notice', async () => {
  let blocked: unknown;
  const client = { status: 'ready', capabilities: { operations: [] }, connect: async () => {}, subscribe: () => () => {}, close() {},
    getAttachment: () => ({ state: { status: 'blocked' }, blocked }), attach: async () => ({ outcome: 'accepted' }) };
  const controller = new TuiSessionController(client as unknown as SessionClient);
  await controller.attach('session');
  expect(controller.blockedText).toBe('Session recovery did not complete.');
  blocked = { kind: 'attach_failed', outcome: 'indeterminate', code: 'indeterminate', message: 'Request timed out' };
  expect(controller.blockedText).toBe('Session recovery did not complete (re-attach got no answer: indeterminate: Request timed out).');
});

it('renders the real protocol session, resizes and restores the terminal on client exit without closing the session', async () => {
  const f = await fixture(); const controller = f.controller(); const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal); const signal = new AbortController();
  const running = runDaemonTerminal(controller, { cwd: f.cwd, clientConfigDir: f.owner.target.agentDir, sessionId: f.root.sessionId, initialMessage: 'terminal input',
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

it('reports the attached session to its Herdr pane from the terminal client: session first, working during the run, then idle', async () => {
  const f = await fixture(); const controller = f.controller(); const terminal = new TestTerminal(); const tui = new TuiAltScreen(terminal);
  const requests: HerdrRequest[] = []; const signal = new AbortController();
  const running = runDaemonTerminal(controller, { cwd: f.cwd, clientConfigDir: f.owner.target.agentDir, sessionId: f.root.sessionId,
    terminal, createTui: () => tui, signal: signal.signal, herdr: new HerdrPane('w1:p1', async request => { requests.push(request); }) });
  try {
    await vi.waitFor(() => expect(requests.map(request => request.params.state ?? 'session')).toEqual(['session', 'idle']));
    expect(requests[0]).toMatchObject({ method: 'pane.report_agent_session', params: { pane_id: 'w1:p1', agent: 'felan', agent_session_id: f.root.sessionId } });
    terminal.input('terminal input'); terminal.input('\r');
    await vi.waitFor(() => expect(controller.history.some(row => row.role === 'assistant')).toBe(true));
    await vi.waitFor(() => expect(requests.map(request => request.params.state ?? 'session')).toEqual(['session', 'idle', 'working', 'idle']));
    expect(requests.every(request => request.params.agent_session_id === f.root.sessionId)).toBe(true);
    terminal.input('\x04'); await running;
  } finally { signal.abort(); await running; }
});

it('allows terminal exit during an unresolved connection and releases the connection deadline', async () => {
  const f = await fixture(); const terminal = new TestTerminal();
  const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
    expected: f.owner.identity, clientVersion: 'fixture', kind: 'tui', connector: () => new Promise(() => {}) });
  const controller = new TuiSessionController(client); const signal = new AbortController();
  const running = runDaemonTerminal(controller, { cwd: f.cwd, clientConfigDir: f.owner.target.agentDir, terminal, signal: signal.signal });
  try {
    expect(terminal.active).toBe(true); terminal.input('\x04'); await running;
    expect(client.status).toBe('closed'); expect(terminal.active).toBe(false);
  } finally { signal.abort(); await running; }
});

it('keeps an editor draft when the model shortcut opens and cancels its selector', async () => {
  const f = await fixture(); const controller = f.controller(); const terminal = new TestTerminal(); const tui = new TuiAltScreen(terminal);
  const signal = new AbortController(); const running = runDaemonTerminal(controller, { cwd: f.cwd, clientConfigDir: f.owner.target.agentDir, sessionId: f.root.sessionId, terminal, createTui: () => tui, signal: signal.signal });
  try {
    await vi.waitFor(() => expect(controller.state?.status).toBe('live'));
    const before = f.root.runtime.session.messages.length;
    terminal.input('unsubmitted draft'); terminal.input('\x0c');
    await vi.waitFor(() => expect(screenText(tui)).toMatch(/Model\s+>\s+→ ✓ fixture \[offline\]/u));
    expect(screenText(tui)).not.toContain('Filter choices');
    terminal.input('\x1b'); await vi.waitFor(() => expect(screenText(tui)).not.toContain('→ ✓ fixture [offline]'));
    tui.renderNow(true); expect(tui.getScreenLines().join('\n')).toContain('unsubmitted draft');
    expect(f.root.runtime.session.messages).toHaveLength(before);
    terminal.input('\x03'); terminal.input('\x04'); await running;
  } finally { signal.abort(); await running; }
});

it('loads local preferences without replacing input typed during startup', async () => {
  const f = await fixture(); const controller = f.controller(); const terminal = new TestTerminal(); const tui = new TuiAltScreen(terminal);
  const entered = gate(); const release = gate(); const load = ClientPreferencesStore.prototype.load;
  vi.spyOn(ClientPreferencesStore.prototype, 'load').mockImplementationOnce(async function () { entered.resolve(); await release.promise; await load.call(this); });
  const signal = new AbortController();
  const running = runDaemonTerminal(controller, { cwd: f.cwd, clientConfigDir: f.owner.target.agentDir, sessionId: f.root.sessionId, initialDraft: 'initial draft', terminal, createTui: () => tui, signal: signal.signal });
  try {
    expect(terminal.active).toBe(true); await entered.promise;
    terminal.input(' plus typed text'); release.resolve();
    await vi.waitFor(() => expect(controller.state?.status).toBe('live'));
    tui.renderNow(true); expect(tui.getScreenLines().join('\n')).toContain('initial draft plus typed text');
    expect(f.root.runtime.session.messages).toHaveLength(0);
  } finally { release.resolve(); signal.abort(); await running; }
});

it('exits while a local preference read remains unresolved', async () => {
  const f = await fixture(); const controller = f.controller(); const terminal = new TestTerminal();
  const entered = gate(); const release = gate(); const load = ClientPreferencesStore.prototype.load;
  vi.spyOn(ClientPreferencesStore.prototype, 'load').mockImplementationOnce(async function () { entered.resolve(); await release.promise; await load.call(this); });
  const signal = new AbortController(); const running = runDaemonTerminal(controller, { cwd: f.cwd, clientConfigDir: f.owner.target.agentDir, terminal, signal: signal.signal });
  try {
    await entered.promise; terminal.input('\x04'); await running;
    expect(terminal.active).toBe(false); expect(controller.client.status).toBe('closed');
    expect(controller.sessionId).toBeUndefined();
  } finally { release.resolve(); signal.abort(); await running; }
});

it('uses client shortcuts in the active terminal and retains the saved setting after a rejected change', async () => {
  const f = await fixture(); await f.preferences.update({ keybindings: { 'app.exit': 'alt+x', 'app.model.select': 'alt+m' } });
  const controller = f.controller(); const terminal = new TestTerminal(); const tui = new TuiAltScreen(terminal);
  const signal = new AbortController(); const running = runDaemonTerminal(controller, { cwd: f.cwd, clientConfigDir: f.owner.target.agentDir, sessionId: f.root.sessionId, terminal, createTui: () => tui, signal: signal.signal });
  try {
    await vi.waitFor(() => expect(controller.state?.status).toBe('live'));
    terminal.input('retained draft'); terminal.input('\x1bm');
    await vi.waitFor(() => expect(screenText(tui)).toMatch(/Model\s+>\s+→ ✓ fixture \[offline\]/u));
    terminal.input('\x1b'); await vi.waitFor(() => expect(screenText(tui)).not.toContain('→ ✓ fixture [offline]'));
    tui.renderNow(true); expect(tui.getScreenLines().join('\n')).toContain('retained draft');
    terminal.input('\x03');
    vi.spyOn(ClientPreferencesStore.prototype, 'update').mockRejectedValueOnce(new Error('cannot write preferences'));
    terminal.input('/settings'); terminal.input('\r');
    await vi.waitFor(() => expect(screenText(tui)).toContain('General settings'));
    terminal.input('\r');
    await vi.waitFor(() => expect(screenText(tui)).toContain('Hide thinking'));
    terminal.input('Hide thinking'); terminal.input('\r');
    await vi.waitFor(() => {
      expect(controller.notice).toBe('Client preferences: cannot write preferences');
      tui.renderNow(true);
      const visible = stripTerminalSequences(tui.getScreenLines().join('\n'));
      expect(visible).toContain('Client preferences: cannot write preferences');
      expect(visible).toMatch(/Hide thinking\s+false/u);
    });
    expect((await f.preferences.load(), f.preferences.values.hideThinking)).toBe(false);
    terminal.input('\r');
    await vi.waitFor(async () => {
      expect((await f.preferences.load(), f.preferences.values.hideThinking)).toBe(true);
      expect(screenText(tui)).toMatch(/Hide thinking\s+true/u);
      expect(controller.notice).toContain('Display preferences saved.');
    });
    terminal.input('\x1b'); await vi.waitFor(() => expect(screenText(tui)).toContain('General settings'));
    terminal.input('\x1b'); await vi.waitFor(() => expect(screenText(tui)).not.toContain('General settings'));
    expect(screenText(tui)).not.toContain('/settings');
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
  const logout = vi.fn(async () => true);
  const options = { cwd: f.cwd, exit: vi.fn(), login, logout, dependencies };
  expect(await submitTuiInput(controller, fakeDialogs(), '/login', options)).toBe(true);
  expect(await submitTuiInput(controller, fakeDialogs(), '/dependencies', options)).toBe(false);
  expect(login).toHaveBeenCalledOnce(); expect(dependencies).toHaveBeenCalledOnce(); expect(controller.sessionId).toBeUndefined();
  expect(await submitTuiInput(controller, fakeDialogs(), '/login Fixture Provider', options)).toBe(true);
  expect(login).toHaveBeenLastCalledWith('Fixture Provider');
  expect(await submitTuiInput(controller, fakeDialogs(), '/logout', options)).toBe(true);
  expect(logout).toHaveBeenCalledOnce();
  await expect(submitTuiInput(controller, fakeDialogs(), '/logout provider', options)).rejects.toThrow('Usage: /logout');
  const completions = await createCommandAutocomplete(controller).getSuggestions(['/dep'], 0, 4, { signal: new AbortController().signal });
  expect(completions?.items).toContainEqual({ value: 'dependencies', label: 'dependencies', description: 'Set up runtime dependencies' });
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

it('treats exit as a client-only action and closes on /close', async () => {
  const f = await fixture(); const controller = f.controller(); await controller.start({ cwd: f.cwd, sessionId: f.root.sessionId });
  const dialogs = fakeDialogs(); const exit = vi.fn();
  expect(await submitTuiInput(controller, dialogs, '/exit', { cwd: f.cwd, exit })).toBe(true);
  expect(exit).toHaveBeenCalledOnce(); expect(f.store.session(f.root.sessionId).state).toBe('open');
  expect(await submitTuiInput(controller, dialogs, '/close', { cwd: f.cwd, exit })).toBe(true);
  expect(dialogs.confirm).not.toHaveBeenCalled(); expect(f.store.session(f.root.sessionId).state).toBe('closed');
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

it('stops or restarts an idle daemon without confirmation or an attached session', async () => {
  const f = await fixture(); const controller = f.controller(); await controller.client.connect();
  const dialogs = fakeDialogs(); const daemon = vi.fn(async () => {});
  expect(await submitTuiInput(controller, dialogs, '/daemon restart force', { cwd: f.cwd, exit: vi.fn(), daemon })).toBe(true);
  expect(dialogs.confirm).not.toHaveBeenCalled(); expect(daemon).toHaveBeenCalledWith('restart', true);
  expect(await submitTuiInput(controller, dialogs, '/restart', { cwd: f.cwd, exit: vi.fn(), daemon })).toBe(true);
  expect(daemon).toHaveBeenLastCalledWith('relaunch', false);
});

it('keeps input usable with a clear notice while the daemon is disconnected without announcing routine reconnection', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const listeners = new Set<() => void>();
  const client = { status: 'ready', reconnection: { attempt: 2, retryAt: Date.now() + 4_000 } as { attempt: number; retryAt: number } | undefined,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    getAttachment: () => undefined, capabilities: { operations: ['prompt'] }, request: vi.fn(), close: vi.fn() };
  const emit = () => { for (const listener of listeners) listener(); };
  const controller = new TuiSessionController(client as unknown as SessionClient);
  try {
    client.status = 'disconnected'; emit();
    expect(await controller.submit('hello')).toBe(false);
    expect(controller.notice).toBe('Daemon disconnected; reconnecting automatically. Use /reconnect to retry now. The input remains in the editor.');
    await expect(controller.perform('prompt', { text: 'hello' }, 'session')).rejects.toThrow('reconnecting automatically');
    expect(client.request).not.toHaveBeenCalled();
    client.status = 'ready'; client.reconnection = undefined; emit();
    expect(controller.notes.some(note => note.text === 'Reconnected')).toBe(false);
  } finally { vi.useRealTimers(); await controller.dispose(); }
});

it('anchors notes to the latest entry, replaces back-to-back status lines and starts fresh per session', async () => {
  const listeners = new Set<() => void>();
  const message = (id: string): Message => ({ id, entryId: id, role: 'user', timestamp: 1, content: [{ type: 'text', text: id }] });
  const sessions = new Map(['a', 'b'].map(session => [session, { ...snapshot(), session, root: session, history: { revision: 0, branch: 'branch', entries: [message(`${session}1`)] } }]));
  const client = { status: 'ready', subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    getAttachment: (session: string) => sessions.has(session) ? { state: { status: 'live', snapshot: sessions.get(session) } } : undefined,
    attach: vi.fn(async () => ({ outcome: 'accepted' })), detach: vi.fn(async () => {}), close: vi.fn() };
  const emit = () => { for (const listener of listeners) listener(); };
  const controller = new TuiSessionController(client as unknown as SessionClient);
  const notes = () => controller.notes.map(({ after, text, level }) => ({ after, text, level }));
  try {
    controller.setNotice('Before attach');
    await controller.attach('a');
    expect(notes()).toEqual([{ after: 'a1', text: 'Before attach', level: 'info' }]);
    const a = sessions.get('a')!; a.history = { ...a.history, entries: [...a.history.entries, message('a2')] }; emit();
    controller.setNotice('Model: first'); controller.setNotice('Model: second');
    a.presentation = [{ id: 'notification:warning', kind: 'notification', level: 'warning', text: 'Disk almost full' }]; emit(); emit();
    controller.setNotice('Thinking level: high');
    expect(notes()).toEqual([{ after: 'a1', text: 'Before attach', level: 'info' }, { after: 'a2', text: 'Model: second', level: 'info' },
      { after: 'a2', text: 'Disk almost full', level: 'warning' }, { after: 'a2', text: 'Thinking level: high', level: 'info' }]);
    await controller.attach('b');
    expect(controller.notes).toEqual([]);
  } finally { await controller.dispose(); }
});

it('confirms once before a daemon action would interrupt active runs', async () => {
  const entered = gate(); const release = gate();
  cleanup.push(async () => release.resolve());
  const f = await fixture(async () => { entered.resolve(); await release.promise; });
  const controller = f.controller(); await controller.start({ cwd: f.cwd, sessionId: f.root.sessionId });
  expect(await controller.submit('keep running')).toBe(true); await entered.promise;
  const dialogs = fakeDialogs(); const daemon = vi.fn(async () => {});
  expect(await submitTuiInput(controller, dialogs, '/daemon stop', { cwd: f.cwd, exit: vi.fn(), daemon })).toBe(false);
  expect(dialogs.confirm).toHaveBeenCalledExactlyOnceWith('Stop daemon', expect.stringContaining('1 active task')); expect(daemon).not.toHaveBeenCalled();
  vi.mocked(dialogs.confirm).mockClear().mockResolvedValueOnce(true);
  expect(await submitTuiInput(controller, dialogs, '/daemon stop', { cwd: f.cwd, exit: vi.fn(), daemon })).toBe(true);
  expect(dialogs.confirm).toHaveBeenCalledOnce(); expect(daemon).toHaveBeenCalledExactlyOnceWith('stop', true);
  release.resolve(); await controller.cancel();
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
  expect(result?.items).toContainEqual({ value: 'model', label: 'model', description: 'Select model (opens selector UI)' });
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

it.each([false, true])('applies execution overrides to the interactive session (resume=%s), not persistent defaults', async resume => {
  const definition = defineExtensionConfig({ id: 'codex', title: 'Fixture', fields: { fast: configField.boolean({ default: false, description: 'Fixture' }) } });
  const f = await fixture(undefined, [definition]);
  const controller = f.controller();
  await controller.start({ cwd: f.cwd, ...(resume ? { sessionId: f.root.sessionId } : {}), config: { extensionConfig: { codex: { fast: true } } } });
  const id = controller.sessionId!;
  expect(id === f.root.sessionId).toBe(resume);
  expect(f.store.session(id).profile?.extensionConfigOverrides).toEqual(expect.arrayContaining([
    expect.objectContaining({ extensionId: 'codex', values: { fast: true } }),
  ]));
  expect(await controller.perform('config.get', { scope: 'global' })).toMatchObject({ outcome: 'accepted', result: { values: { extensionConfig: { codex: { fast: false } } } } });
});
