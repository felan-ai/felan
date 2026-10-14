import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ScrollView, TuiAltScreen, stripTerminalSequences, type ProgramStatus, type Terminal } from '@earendil-works/pi-tui';
import { identityFor } from '../../daemon/src/daemon/target.js';
import type { Interaction, Operation, SetupJob } from '@felan-ai/session-protocol';
import { SessionClient } from '../src/client/client.js';
import { TuiSessionController } from '../src/tui/controller.js';
import type { TuiPreferencesUpdate } from '../src/tui/preferences-schema.js';
import { runDaemonTerminal } from '../src/tui/run.js';
import { TERMINAL_INTERACTION_KINDS } from '../src/tui/interactions.js';
import { FakeTransport, snapshot } from './client-fixtures.js';
import { checkForFelanUpdate } from '../src/update.js';

vi.mock('../src/update.js', () => ({ checkForFelanUpdate: vi.fn() }));
beforeEach(() => { vi.mocked(checkForFelanUpdate).mockResolvedValue(undefined); });

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const question: Interaction = { id: 'model-question', scope: { kind: 'host' }, createdAt: 1, state: 'waiting', request: { kind: 'input', title: 'Model question must wait' } };

async function fixture(options: { provider?: boolean; statusAvailable?: boolean; createError?: boolean; askBeforeAttach?: boolean; dependencies?: boolean; preferences?: TuiPreferencesUpdate; incompatibleWork?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tui-startup-')); const fake = new FakeTransport();
  await mkdir(join(directory, 'tui'));
  await writeFile(join(directory, 'tui/settings.json'), JSON.stringify({ showImages: false, ...options.preferences }));
  const operations: Operation[] = ['attach', 'detach', 'sessions.create', 'prompt', 'interaction.answer',
    'host.setup.catalog', 'host.setup.start', 'host.setup.read', 'host.setup.answer', 'host.setup.cancel', 'host.setup.open_link',
    ...(options.statusAvailable === false ? [] : ['host.status' as const])];
  const client = new SessionClient({ target: { kind: 'isolated', directory, namespaceId: 'startup-test' }, kind: 'tui', clientVersion: 'fixture',
    interactionKinds: [...TERMINAL_INTERACTION_KINDS], connector: fake.connector, retries: 0,
    ...(options.incompatibleWork === undefined ? {} : { expectedDaemonVersion: 'installed' }) });
  const identity = identityFor(client.target, 'instance'); const controller = new TuiSessionController(client);
  const terminal = new TestTerminal(); const tui = new TuiAltScreen(terminal); const abort = new AbortController();
  let loggedIn = options.provider ?? false; let cancelled = false;
  const waiting: SetupJob = { id: 'login-job', kind: 'login', state: 'waiting', message: 'Waiting for credentials',
    prompt: { id: 'key', kind: 'input', message: 'Secret API key', secret: true } };
  fake.onSend = (request, connection) => {
    switch (request.op) {
      case 'hello': fake.reply(request, { attachmentId: 'client', principal: 'principal', daemonVersion: 'fixture', protocol: 1,
        identity, operations, interactionKinds: [...TERMINAL_INTERACTION_KINDS] }, connection); break;
      case 'host.status': fake.reply(request, { identity, daemonVersion: 'fixture', protocol: 1, state: 'ready',
        active: { sessions: 0, runs: 0, work: options.incompatibleWork ?? 0, attachments: 0 }, setupNeeds: loggedIn ? [] : [{ code: 'provider', message: 'No model available' }] }, connection); break;
      case 'sessions.create':
        if (options.createError) fake.frame({ v: 1, re: request.id, outcome: 'rejected', error: { code: 'invalid_request', message: 'Invalid working directory.', retryable: false } }, connection);
        else fake.reply(request, { sessionId: 'session' }, connection);
        break;
      case 'attach':
        if (options.askBeforeAttach) fake.frame({ v: 1, interaction: question }, connection);
        fake.reply(request, { attachmentId: 'binding', snapshot: snapshot() }, connection); break;
      case 'host.setup.catalog': fake.reply(request, { providers: [{ id: 'provider', label: 'Fixture provider', configured: loggedIn, subscription: false, apiKeyLogin: true, methods: ['api_key'] }],
        credentials: [], dependencies: options.dependencies ? [{ id: 'dependency', label: 'Optional dependency', description: 'Reviewed install', enabled: true, available: false, installable: true, needsSetup: true }] : [] }, connection); break;
      case 'host.setup.start': fake.reply(request, waiting, connection); break;
      case 'host.setup.cancel': cancelled = true; fake.reply(request, {}, connection); break;
      case 'host.setup.read': fake.reply(request, cancelled ? { id: 'login-job', kind: 'login', state: 'cancelled', message: 'Cancelled' } : loggedIn ? { id: 'login-job', kind: 'login', state: 'completed', message: 'Done' } : waiting, connection); break;
      case 'host.setup.answer': loggedIn = true; fake.reply(request, {}, connection); break;
      case 'prompt': fake.reply(request, { runId: 'run' }, connection); break;
      default: fake.reply(request, {}, connection);
    }
  };
  let running: Promise<void> | undefined;
  cleanups.push(async () => { abort.abort(); if (running) await running.catch(() => {}); await controller.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { client, controller, terminal, tui, fake, abort,
    start(extra: Partial<Parameters<typeof runDaemonTerminal>[1]> = {}) {
      running = runDaemonTerminal(controller, { cwd: directory, clientConfigDir: directory, terminal, createTui: () => tui, signal: abort.signal, ...extra });
      void running.catch(() => {}); return running;
    },
    text() { tui.renderNow(true); return stripTerminalSequences(tui.getScreenLines().join('\n')); },
  };
}

async function openLogin(f: Awaited<ReturnType<typeof fixture>>) {
  f.terminal.input('\x03'); f.terminal.input('/login'); f.terminal.input('\r');
  await vi.waitFor(() => expect(f.text()).toContain('Select authentication method:'));
  f.terminal.input('\x1b[B'); f.terminal.input('\r');
  await vi.waitFor(() => expect(f.text()).toContain('Select provider to configure:'));
  f.terminal.input('\r');
  await vi.waitFor(() => expect(f.text()).toContain('Secret API key'));
}

it('applies persisted fullscreen controls and quiet startup to the active terminal', async () => {
  const scroll = vi.spyOn(ScrollView.prototype, 'setScrollbar');
  const wheel = vi.spyOn(TuiAltScreen.prototype, 'setWheelScrollLines');
  const cursor = vi.spyOn(TuiAltScreen.prototype, 'setShowHardwareCursor');
  const clear = vi.spyOn(TuiAltScreen.prototype, 'setClearOnShrink');
  const f = await fixture({ provider: true, preferences: { quietStartup: true, fullscreenScrollbar: 'hidden',
    fullscreenCopyOnSelect: false, fullscreenWheelScrollLines: 5, hardwareCursor: true, clearOnShrink: true } });
  f.start(); await vi.waitFor(() => expect(f.controller.sessionId).toBe('session'));
  expect(scroll).toHaveBeenCalledWith('hidden'); expect(wheel).toHaveBeenCalledWith(5);
  expect(cursor).toHaveBeenCalledWith(true); expect(clear).toHaveBeenCalledWith(true);
  expect(f.tui.getCopyOnSelect()).toBe(false); expect(f.text()).not.toContain('Felan Code');
});

it('shows an update notice without waiting for the version check before attaching', async () => {
  let complete!: (version: string) => void;
  vi.mocked(checkForFelanUpdate).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const f = await fixture({ provider: true }); f.start();
  await vi.waitFor(() => expect(f.controller.sessionId).toBe('session'));
  expect(f.terminal.active).toBe(true);
  await vi.waitFor(() => expect(checkForFelanUpdate).toHaveBeenCalled());
  complete('99.0.0');
  await vi.waitFor(() => expect(f.text()).toContain('Felan 99.0.0 is available'));
  expect(f.text()).toContain('felan update');
});

it('cancels the update check on exit and ignores late results', async () => {
  let complete!: (version: string) => void; let signal!: AbortSignal;
  vi.mocked(checkForFelanUpdate).mockImplementationOnce(options => {
    signal = options!.signal!;
    return new Promise(resolve => { complete = resolve; });
  });
  const f = await fixture({ provider: true }); const running = f.start();
  await vi.waitFor(() => expect(signal).toBeDefined());
  f.abort.abort(); await running;
  expect(signal.aborted).toBe(true);
  complete('99.0.0'); await Promise.resolve();
  expect(f.controller.notice).not.toContain('99.0.0');
});

it('keeps first-run startup connected without creating or submitting and retains both initial inputs', async () => {
  const f = await fixture(); f.start({ initialDraft: 'retained draft', initialMessage: 'original prompt' });
  await vi.waitFor(() => expect(f.controller.notice).toContain('No model is available'));
  expect(f.terminal.active).toBe(true); expect(f.client.status).toBe('ready'); expect(f.controller.sessionId).toBeUndefined();
  expect(f.text()).toContain('retained draft');
  expect(f.fake.requests.some(request => request.op === 'sessions.create' || request.op === 'prompt')).toBe(false);
  await openLogin(f); f.terminal.input('test-api-key'); f.terminal.input('\r');
  await vi.waitFor(() => expect(f.controller.notice).toContain('Login completed. Use /new'), { timeout: 3_000 });
  expect(f.fake.requests.some(request => request.op === 'sessions.create' || request.op === 'prompt')).toBe(false);
  const history: string[] = [];
  for (let index = 0; index < 6; index++) { f.terminal.input('\x1b[A'); history.push(f.text()); }
  expect(history.some(text => text.includes('original prompt'))).toBe(true);
  expect(history.some(text => text.includes('retained draft'))).toBe(true);
  f.terminal.input('\x03'); f.terminal.input('/new'); f.terminal.input('\r');
  await vi.waitFor(() => expect(f.controller.sessionId).toBe('session'));
  expect(f.fake.requests.filter(request => request.op === 'sessions.create')).toHaveLength(1);
  expect(f.fake.requests.filter(request => request.op === 'prompt')).toHaveLength(0);
});

it('retains an initial message visibly and does not exit an unavailable resume into setup', async () => {
  const f = await fixture(); f.start({ initialMessage: 'review before sending', resume: true });
  await vi.waitFor(() => expect(f.controller.notice).toContain('No model is available'));
  expect(f.terminal.active).toBe(true); expect(f.text()).toContain('review before sending');
  expect(f.fake.requests.some(request => request.op === 'sessions.create')).toBe(false);
});

it('keeps initial input recoverable and never submits it when login is cancelled', async () => {
  const f = await fixture(); f.start({ initialMessage: 'unsent initial request' });
  await vi.waitFor(() => expect(f.controller.notice).toContain('No model is available'));
  await openLogin(f); f.terminal.input('\x1b');
  await vi.waitFor(() => expect(f.fake.requests.some(request => request.op === 'host.setup.cancel')).toBe(true));
  await vi.waitFor(() => expect(f.text()).toContain('Select provider to configure:'));
  f.terminal.input('\x1b');
  await vi.waitFor(() => expect(f.text()).toContain('Select authentication method:')); f.terminal.input('\x1b');
  f.terminal.input('\x03'); f.terminal.input('\x1b[A'); f.terminal.input('\x1b[A');
  expect(f.text()).toContain('unsent initial request');
  expect(f.fake.requests.some(request => request.op === 'sessions.create' || request.op === 'prompt')).toBe(false);
});

it('keeps the capability-absence fallback and propagates unrelated session-creation errors', async () => {
  const fallback = await fixture({ statusAvailable: false }); fallback.start();
  await vi.waitFor(() => expect(fallback.controller.sessionId).toBe('session'));
  expect(fallback.fake.requests.some(request => request.op === 'host.status')).toBe(false);
  const broken = await fixture({ provider: true, createError: true });
  await expect(broken.start()).rejects.toThrow('Invalid working directory'); expect(broken.terminal.active).toBe(false);
});

it('does not swallow fatal connection errors as provider setup', async () => {
  const f = await fixture(); vi.spyOn(f.client, 'connect').mockRejectedValueOnce(new Error('Connection failed.'));
  await expect(f.start()).rejects.toThrow('Connection failed.'); expect(f.terminal.active).toBe(false);
  expect(f.controller.notice).not.toContain('No model is available');
});

it.each(['complete', 'cancel'] as const)('queues an arriving model question until secret setup %ss', async finish => {
  const f = await fixture(); f.start(); await vi.waitFor(() => expect(f.controller.notice).toContain('No model is available'));
  await openLogin(f);
  f.fake.frame({ v: 1, interaction: question });
  await vi.waitFor(() => expect(f.client.getInteractions()).toHaveLength(1));
  expect(f.text()).toContain('Secret API key'); expect(f.text()).not.toContain('Model question must wait');
  f.terminal.input('private-credential');
  expect(f.text()).not.toContain('private-credential');
  expect(f.fake.requests.some(request => request.op === 'interaction.answer')).toBe(false);
  f.terminal.input(finish === 'complete' ? '\r' : '\x1b');
  if (finish === 'cancel') {
    await vi.waitFor(() => expect(f.text()).toContain('Select provider to configure:')); f.terminal.input('\x1b');
    await vi.waitFor(() => expect(f.text()).toContain('Select authentication method:')); f.terminal.input('\x1b');
  }
  await vi.waitFor(() => expect(f.text()).toContain('Model question must wait'), { timeout: 3_000 });
  const answers = f.fake.requests.filter(request => request.op === 'host.setup.answer');
  expect(answers).toHaveLength(finish === 'complete' ? 1 : 0);
  f.terminal.input('\x1b');
  await vi.waitFor(() => expect(f.fake.requests.some(request => request.op === 'interaction.answer')).toBe(true));
  expect(JSON.stringify(f.fake.requests.filter(request => request.op === 'interaction.answer'))).not.toContain('private-credential');
});

it('does not start attachment onboarding while a model question is being presented', async () => {
  const f = await fixture({ provider: true, askBeforeAttach: true, dependencies: true }); f.start();
  await vi.waitFor(() => expect(f.text()).toContain('Model question must wait'));
  expect(f.text()).not.toContain('Install optional extensions');
  expect(f.fake.requests.some(request => request.op === 'host.setup.start')).toBe(false);
});

class TestTerminal implements Terminal {
  columns = 110; rows = 30; kittyProtocolActive = false; active = false;
  input: (data: string) => void = () => {};
  start(input: (data: string) => void): void { this.active = true; this.input = input; }
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

it('asks before restarting an incompatible daemon whose only active work is a background process', async () => {
  const f = await fixture({ provider: true, incompatibleWork: 1 }); const onDaemonAction = vi.fn(async () => true);
  const running = f.start({ onDaemonAction });
  await vi.waitFor(() => expect(f.text().replace(/\s+/gu, ' ')).toContain('1 active task will be interrupted'));
  f.terminal.input('\x1b'); await running;
  expect(onDaemonAction).not.toHaveBeenCalled();
  expect(f.fake.controls).toEqual([]);
});
