import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { getTerminalColorMode, stripTerminalSequences } from '@earendil-works/pi-tui';
import { createAssistantMessageEventStream, type ModelRuntime } from '@felan-ai/agent-core';
import { clientDaemonTarget } from '../src/client-application.js';
import { resolveClientHostComposition } from '../src/daemon-entrypoint.js';
import { bundledClientThemes } from '../src/tui/theme.js';
import { DaemonConfiguration } from '../src/providers/configuration.js';
import { DaemonTuiPreferences } from '../src/providers/tui-preferences.js';
import { createRegistryInteractionBroker } from '../../daemon/src/daemon/broker.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { DAEMON_VERSION } from '../../daemon/src/version.js';
import { gate, serverFixture } from '../../daemon/test/fixtures/server.js';
import { assistant, offlineModel } from '../../daemon/test/fixtures/registry.js';
import { ManualTerminalGrid } from './fixtures/manual-terminal-grid.js';

const root = new URL('../../../', import.meta.url);
const coreRequire = createRequire(new URL('packages/agent-core/package.json', root));
interface NativePty {
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal: string): void;
}
const native = coreRequire('@lydell/node-pty') as { spawn(file: string, args: string[], options: {
  name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv;
}): NativePty };

async function bounded<T>(work: Promise<T>, label: string, milliseconds = 12_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`Deadline: ${label}`)), milliseconds); })]);
  } finally { clearTimeout(timeout); }
}

class Capture {
  readonly grid = new ManualTerminalGrid(120, 32);
  raw = '';
  frameRaw = '';
  error: unknown;
  exit: { exitCode: number; signal?: number } | undefined;
  readonly exited: Promise<void>;
  private readonly listeners = new Set<() => void>();
  readonly terminal: ReturnType<typeof native.spawn>;
  private readonly subscriptions: Array<{ dispose(): void }>;
  constructor(private readonly output: string, private readonly checkpoints: Record<string, unknown>[], directory: string, cwd: string, sessionId: string) {
    this.terminal = native.spawn(process.execPath, [fileURLToPath(new URL('apps/felan/dist/cli.js', root)), '--daemon-runtime', directory,
      '--session', sessionId], { name: 'xterm-256color', cols: 120, rows: 32, cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', COLORFGBG: '15;0',
        PI_TRUE_COLOR: getTerminalColorMode() === 'truecolor' ? '1' : '0' } });
    let finish!: () => void;
    this.exited = new Promise(resolve => { finish = resolve; });
    this.subscriptions = [this.terminal.onData(data => {
      try {
        this.raw += data;
        if (Buffer.byteLength(this.raw) > 2 * 1024 * 1024) throw new Error('PTY capture exceeds 2 MiB');
        const frames = this.grid.frames;
        this.grid.feed(data);
        if (this.grid.frames > frames) {
          const end = '\x1b[?2026l';
          this.frameRaw = this.raw.slice(0, this.raw.lastIndexOf(end) + end.length);
        }
      } catch (error) { this.error = error; }
      for (const listener of this.listeners) listener();
    }), this.terminal.onExit(event => { this.exit = event; finish(); for (const listener of this.listeners) listener(); })];
  }
  get screen(): string { return this.grid.screen; }
  wait(label: string, predicate: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error(`Screen deadline: ${label}\n${this.screen}`)), 12_000);
      const done = (error?: unknown) => { clearTimeout(timer); this.listeners.delete(check); error ? reject(error) : resolve(); };
      const check = () => { try { if (this.error) done(this.error); else if (predicate()) done(); else if (this.exit) done(new Error(`PTY exited: ${label}`)); } catch (error) { done(error); } };
      this.listeners.add(check); check();
    });
  }
  send(data: string): void { this.terminal.write(data); }
  async snapshot(name: string, facts: Record<string, unknown> = {}): Promise<void> {
    const output = this.output;
    await mkdir(output, { recursive: true });
    const raw = this.frameRaw || this.raw; const observed = this.raw; const plain = this.screen;
    const metadata = { name, columns: this.grid.screenColumns, rows: this.grid.screenRows, frame: this.grid.frames,
      clears: this.grid.clears, bytes: Buffer.byteLength(raw), observedBytes: Buffer.byteLength(observed),
      facts, manualVerdict: 'pending inspection', parser: 'bounded manual-terminal-grid.ts; raw ANSI authoritative' };
    await Promise.all([writeFile(join(output, `${name}.ansi`), raw), writeFile(join(output, `${name}.screen.txt`), `${plain}\n`),
      writeFile(join(output, `${name}.raw.ansi`), observed), writeFile(join(output, `${name}.stream.txt`), stripTerminalSequences(observed)),
      writeFile(join(output, `${name}.json`), JSON.stringify(metadata, null, 2))]);
    this.checkpoints.push(metadata);
  }
  async dispose(): Promise<void> {
    if (!this.exit) this.terminal.kill('SIGKILL');
    await bounded(this.exited, 'PTY cleanup');
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}

async function captureManualTerminal(output: string): Promise<void> {
  const checkpoints: Record<string, unknown>[] = [];
  const firstDelta = gate(); const allowSecondDelta = gate(); const secondDelta = gate(); const release = gate();
  const questionAbort = new AbortController();
  const providerEvents: Array<{ type: string; delta?: string }> = [];
  let providerTask: Promise<void> | undefined;
  let providerCalls = 0;
  const f = await serverFixture({ now: Date.now, namespace: directory => {
    const target = clientDaemonTarget({ daemonRuntime: directory });
    if (target.kind !== 'isolated') throw new Error('Expected isolated target');
    return target.namespaceId;
  } });
  const broker = createRegistryInteractionBroker(f.registry, {  });
  const preferences = new DaemonTuiPreferences({ agentDir: f.owner.target.agentDir, assertCurrent: () => f.registry.assertAdmission() });
  const daemonTarget = clientDaemonTarget({ daemonRuntime: f.directory });
  const composition = await resolveClientHostComposition(daemonTarget);
  const server = new SessionServer({ registry: f.registry, models: f.root.runtime.session.modelRuntime, version: DAEMON_VERSION, broker, preferences, composition,
    configuration: new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.registry.assertAdmission() }) });
  let pty: Capture | undefined;
  let failure: unknown;
  try {
    const models: ModelRuntime = f.root.runtime.session.modelRuntime;
    models.registerProvider('offline', { api: 'openai-completions', baseUrl: offlineModel.baseUrl, apiKey: 'fixture', models: [offlineModel], streamSimple: () => {
      providerCalls++;
      const stream = createAssistantMessageEventStream();
      let text = '';
      const push = (event: Parameters<typeof stream.push>[0]) => {
        providerEvents.push({ type: event.type, ...('delta' in event ? { delta: event.delta } : {}) });
        stream.push(event);
      };
      const delta = (value: string) => {
        text += value;
        push({ type: 'text_delta', contentIndex: 0, delta: value, partial: assistant(text) });
      };
      providerTask = (async () => {
        push({ type: 'start', partial: assistant('') });
        push({ type: 'text_start', contentIndex: 0, partial: assistant('') });
        delta('QA_STREAM_FIRST'); firstDelta.resolve();
        await allowSecondDelta.promise;
        delta('\n\nQA_STREAM_SECOND'); secondDelta.resolve();
        await release.promise;
        delta('\n\ndone');
        push({ type: 'text_end', contentIndex: 0, content: text, partial: assistant(text) });
        push({ type: 'done', reason: 'stop', message: assistant(text) });
      })();
      void providerTask.catch(() => {});
      return stream;
    } });
    await mkdir(join(f.directory, 'client', 'tui'), { recursive: true, mode: 0o700 });
    await writeFile(join(f.directory, 'client', 'tui', 'settings.json'), JSON.stringify({ theme: 'felan-dark' }), { mode: 0o600 });
    await preferences.set({ keybindings: { 'app.model.select': 'alt+m', 'app.exit': 'alt+x' } });
    await server.start(); pty = new Capture(output, checkpoints, f.directory, f.cwd, f.root.sessionId); const terminal = pty;
    const idle = () => f.store.session(f.root.sessionId).run.state === 'idle' && !terminal.screen.includes('Working');
    const filter = () => terminal.screen.includes('Filter choices');
    await terminal.wait('initial connected frame', () => idle() && terminal.screen.includes('Felan Code')
      && terminal.screen.split('\n').at(-2) === '─'.repeat(terminal.grid.screenColumns));
    expect(terminal.raw).toContain(bundledClientThemes().get('felan-dark')!.getFgAnsi('text'));
    expect(terminal.raw).toContain(bundledClientThemes().get('felan-dark')!.getBgAnsi('customMessageBg'));
    expect(terminal.screen.split('\n').at(-2)).toBe('─'.repeat(terminal.grid.screenColumns));
    expect(terminal.screen.split('\n').at(-1)?.trim()).toBe('');
    await terminal.snapshot('01-dark-wide-idle');

    terminal.send('QA retained draft'); await terminal.wait('draft visible', () => terminal.screen.includes('QA retained draft'));
    terminal.send('\x1bm'); await terminal.wait('configured model shortcut', () => filter() && terminal.screen.includes('Model'));
    await terminal.snapshot('02-model-shortcut-draft');
    terminal.send('\x1b'); await terminal.wait('draft restored', () => !filter() && terminal.screen.includes('QA retained draft'));
    expect(f.root.runtime.session.messages).toHaveLength(0);
    await terminal.snapshot('03-shortcut-dismissed');
    terminal.send('\x03'); await terminal.wait('draft cleared', () => !terminal.screen.includes('QA retained draft'));

    terminal.send('/settings\r'); await terminal.wait('settings opened', () => filter() && terminal.screen.includes('Settings'));
    await terminal.snapshot('04-dark-settings');
    terminal.send('Thinking\r'); await terminal.wait('thinking draft toggled', () => terminal.screen.includes('Thinking: hidden'));
    terminal.send('Save display changes\r'); await terminal.wait('preferences saved', () => !filter() && terminal.screen.includes('Display preferences saved'));
    expect((await preferences.get()).hideThinking).toBe(true);
    await terminal.snapshot('05-settings-saved');

    terminal.send('/settings\r'); await terminal.wait('settings reopened', () => filter() && terminal.screen.includes('Settings'));
    terminal.send('Theme\r'); await terminal.wait('local theme picker', () => filter() && terminal.screen.includes('Client theme'));
    await terminal.snapshot('06-local-theme-picker');
    terminal.send('felan-light\r'); await terminal.wait('light theme draft', () => terminal.screen.includes('Theme: felan-light'));
    const paletteOffset = terminal.frameRaw.length;
    terminal.send('Save display changes\r'); await terminal.wait('light palette applied', () => !filter() && terminal.screen.includes('Display preferences saved')
      && terminal.frameRaw.slice(paletteOffset).includes(bundledClientThemes().get('felan-light')!.getFgAnsi('text'))
      && terminal.frameRaw.slice(paletteOffset).includes(bundledClientThemes().get('felan-light')!.getBgAnsi('customMessageBg')));
    expect(JSON.parse(await readFile(join(f.directory, 'client', 'tui', 'settings.json'), 'utf8')).theme).toBe('felan-light');
    expect(JSON.parse(await readFile(join(f.owner.target.agentDir, 'settings.json'), 'utf8'))).not.toHaveProperty('theme');
    await terminal.snapshot('07-light-wide-idle');

    const beforeResize = terminal.grid.clears;
    terminal.grid.resize(52, 18); terminal.terminal.resize(52, 18);
    await terminal.wait('narrow full redraw', () => terminal.grid.clears > beforeResize && terminal.grid.screenColumns === 52 && terminal.grid.screenRows === 18 && idle());
    await terminal.snapshot('08-light-narrow-idle');
    terminal.send('/settings\r'); await terminal.wait('narrow settings', () => filter() && terminal.screen.includes('Settings'));
    await terminal.snapshot('09-light-narrow-settings');
    terminal.send('\x1b'); await terminal.wait('settings dismissed without approval', () => !filter());
    await terminal.wait('cancelled command cleared', () => !terminal.screen.includes('/settings'));

    terminal.send('QA streamed model run\r'); await bounded(firstDelta.promise, 'first provider delta');
    await terminal.wait('first delta rendered while provider held', () => terminal.screen.includes('Working') && terminal.screen.includes('QA_STREAM_FIRST'));
    expect(terminal.screen).not.toContain('QA_STREAM_SECOND');
    expect(f.store.session(f.root.sessionId).run.state).toBe('running');
    await terminal.snapshot('10a-narrow-first-delta', { runState: f.store.session(f.root.sessionId).run.state,
      pendingInteractions: broker.pending().length, providerEventCount: providerEvents.length });
    const question = broker.request({ kind: 'input', title: 'QA pending question' },
      { kind: 'session', session: f.root.sessionId, root: f.root.sessionId }, { signal: questionAbort.signal });
    await terminal.wait('pending broker dialog during run', () => terminal.screen.includes('QA pending question'));
    terminal.send('focus-kept'); await terminal.wait('dialog draft before second delta', () => terminal.screen.includes('focus-kept'));
    await terminal.snapshot('10b-narrow-first-delta-dialog', { runState: f.store.session(f.root.sessionId).run.state,
      pendingInteractions: broker.pending().length, providerEventCount: providerEvents.length });
    const beforeWide = terminal.grid.clears;
    terminal.grid.resize(120, 32); terminal.terminal.resize(120, 32);
    await terminal.wait('wide dialog full redraw', () => terminal.grid.clears > beforeWide && terminal.grid.screenColumns === 120 && terminal.screen.includes('QA pending question'));
    allowSecondDelta.resolve(); await bounded(secondDelta.promise, 'second provider delta while dialog open');
    await terminal.wait('second delta rendered without displacing focused dialog', () => terminal.screen.includes('QA_STREAM_FIRST')
      && terminal.screen.includes('QA_STREAM_SECOND') && terminal.screen.includes('QA pending question') && terminal.screen.includes('focus-kept'));
    terminal.send('-after-delta');
    await terminal.wait('dialog still owns keyboard input', () => terminal.screen.includes('focus-kept-after-delta') && terminal.screen.includes('QA_STREAM_SECOND'));
    expect(broker.pending()).toHaveLength(1); expect(f.store.session(f.root.sessionId).run.state).toBe('running');
    await terminal.snapshot('11-wide-second-delta-focused-dialog', { runState: f.store.session(f.root.sessionId).run.state,
      pendingInteractions: broker.pending().length, providerEventCount: providerEvents.length });
    terminal.send('\r');
    expect(await bounded(question, 'broker answer')).toMatchObject({ state: 'answered', answer: { kind: 'input', text: 'focus-kept-after-delta' } });
    await terminal.wait('dialog answered, model still running', () => !terminal.screen.includes('QA pending question') && terminal.screen.includes('Working'));
    expect(providerEvents.some(event => event.type === 'done')).toBe(false);
    const userMessages = f.root.runtime.session.messages.filter(message => message.role === 'user');
    expect(userMessages).toHaveLength(1); expect(JSON.stringify(userMessages)).not.toContain('focus-kept');
    await terminal.snapshot('12-dialog-answered-stream-held', { runState: f.store.session(f.root.sessionId).run.state,
      pendingInteractions: broker.pending().length, providerEventCount: providerEvents.length });
    release.resolve();
    await terminal.wait('completed model frame', () => idle() && /\bdone\b/u.test(terminal.screen));
    await bounded(providerTask!, 'provider stream completion');
    expect(providerCalls).toBe(1);
    expect(providerEvents.map(event => event.type)).toEqual(['start', 'text_start', 'text_delta', 'text_delta', 'text_delta', 'text_end', 'done']);
    expect(terminal.screen).toContain('QA_STREAM_FIRST'); expect(terminal.screen).toContain('QA_STREAM_SECOND');
    expect(f.store.session(f.root.sessionId).run.state).toBe('idle'); expect(broker.pending()).toHaveLength(0);
    await terminal.snapshot('13-completed-light-wide', { runState: f.store.session(f.root.sessionId).run.state,
      pendingInteractions: broker.pending().length, providerEventCount: providerEvents.length });
    terminal.send('\x1bx'); await bounded(terminal.exited, 'configured detach shortcut');
    expect(terminal.exit?.exitCode).toBe(0); expect(f.store.session(f.root.sessionId).state).toBe('open');
  } catch (error) {
    failure = error;
    if (pty) await pty.snapshot('failure').catch(() => {});
    throw error;
  } finally {
    allowSecondDelta.resolve(); release.resolve(); questionAbort.abort();
    const cleanupErrors: unknown[] = [];
    try { if (providerTask) await bounded(providerTask, 'provider cleanup'); } catch (error) { cleanupErrors.push(String(error)); }
    try { await pty?.dispose(); } catch (error) { cleanupErrors.push(String(error)); }
    try { server.close(); } catch (error) { cleanupErrors.push(String(error)); }
    try { await bounded(broker.drain(), 'broker cleanup'); } catch (error) { cleanupErrors.push(String(error)); }
    try { await bounded(f.dispose(), 'fixture cleanup'); } catch (error) { cleanupErrors.push(String(error)); }
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'manifest.json'), JSON.stringify({ status: failure ? 'probe failed' : cleanupErrors.length ? 'cleanup failed' : 'captured; manual inspection pending',
      failure: failure instanceof Error ? failure.stack : failure, cleanupErrors, checkpoints, providerCalls, providerEvents,
      limitations: ['No real provider/network, tool-output streaming, or stream-interruption race coverage.', 'No OAuth/setup flow or secret-entry interleaving.',
        'Plain grids omit SGR color and support only the pinned TUI escape subset; inspect matching raw ANSI.', 'No subjective layout, contrast, or accessibility pass is asserted.'] }, null, 2));
    if (cleanupErrors.length && !failure) throw new Error(`Cleanup failed: ${cleanupErrors.join('; ')}`);
  }
}

it('captures emitted-CLI layout, palettes, shortcuts, resize and live model deltas under a focused broker dialog', async () => {
  const retain = process.env.FELAN_TEST_DIST_SMOKE === '1';
  const output = retain ? '/tmp/v/e/manual-pty' : await mkdtemp(join(tmpdir(), 'felan-manual-pty-'));
  try { await captureManualTerminal(output); }
  finally { if (!retain) await rm(output, { recursive: true, force: true }); }
}, 90_000);
