import { afterEach, expect, it, vi } from 'vitest';
import { TuiAltScreen, setKeybindings, stripTerminalSequences, type ProgramStatus, type Terminal, type TUI } from '@earendil-works/pi-tui';
import type { Message, ResponseFor, SessionSnapshot } from '@felan-ai/session-protocol';
import type { SessionClient } from '../src/client/client.js';
import { AgentTranscript } from '../src/subagents/agent-transcript.js';
import { TuiSessionController } from '../src/tui/controller.js';
import { createClientKeybindings } from '../src/tui/keybindings.js';
import { DaemonTuiScreen } from '../src/tui/screen.js';
import { defaultClientTheme } from '../src/tui/theme.js';
import { projectTuiTranscript } from '../src/tui/transcript.js';
import { snapshot } from './client-fixtures.js';

const settings = { hideThinking: false, showImages: false, imageWidthCells: 60, outputPad: 1, toolMode: 'grouped' as const };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

function user(id: string, text: string): Message {
  return { id, entryId: id, role: 'user', timestamp: 1, content: [{ type: 'text', text }] };
}

async function fixture(history: Message[] = []) {
  const listeners = new Set<() => void>();
  const state = snapshot(); state.history.entries = history;
  const sessions = new Map<string, SessionSnapshot>([['session', state], ['other', { ...snapshot(), session: 'other', root: 'other' }]]);
  let resolve!: (response: ResponseFor<'prompt'>) => void;
  let reject!: (error: Error) => void;
  const waiting = new Promise<ResponseFor<'prompt'>>((yes, no) => { resolve = yes; reject = no; });
  const request = vi.fn(() => waiting);
  const client = {
    status: 'ready', capabilities: { operations: ['prompt', 'steer', 'follow_up', 'session.history', 'close'] }, request,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    readAttachment: (session: string) => sessions.has(session) ? { state: { status: 'live', snapshot: sessions.get(session) } } : undefined,
    attach: vi.fn(async () => ({ outcome: 'accepted' })), detach: vi.fn(async () => {}), close: vi.fn(),
  };
  const controller = new TuiSessionController(client as unknown as SessionClient);
  await controller.attach('session');
  cleanups.push(async () => { resolve({ outcome: 'accepted', result: { runId: 'run' } } as ResponseFor<'prompt'>); await controller.dispose(); });
  const project = () => projectTuiTranscript(controller.snapshot!, controller.history, settings, controller.notes, controller.promptEchoes);
  const emit = () => { for (const listener of listeners) listener(); };
  const publish = (...messages: Message[]) => {
    state.history = { ...state.history, entries: [...state.history.entries, ...messages] }; state.revision++; emit();
  };
  const run = (stateName: SessionSnapshot['run']['state'], id?: string) => {
    state.run = { state: stateName, ...(id ? { id } : {}) }; state.revision++; emit();
  };
  return { controller, client, state, project, emit, publish, run, resolve, reject };
}

it.each(['idle', 'interrupted'] as const)('echoes an %s prompt synchronously without changing canonical history', async runState => {
  const f = await fixture([user('earlier', 'Repeat me')]);
  f.state.run = { state: runState };
  const seen: number[] = [];
  f.controller.subscribe(() => seen.push(f.project().messages.length));
  const submitting = f.controller.submit('Repeat me');
  expect(seen).toEqual([2]);
  expect(f.controller.busy).toBe(true);
  expect(f.project().messages.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'Repeat me' }] });
  expect(f.controller.history).toEqual([user('earlier', 'Repeat me')]);
  expect(f.state.history.entries).toHaveLength(1);
  f.resolve({ outcome: 'accepted', result: { runId: 'run' } } as ResponseFor<'prompt'>);
  expect(await submitting).toBe(true);
  expect(f.project().messages).toHaveLength(2);
  expect(f.controller.promptEchoes[0]?.message).toBeUndefined();
  f.publish(user('confirmed', 'Repeat me'));
  expect(f.controller.promptEchoes[0]?.message).toBe('confirmed');
  expect(f.controller.history).toHaveLength(2);
  expect(f.project().messages).toHaveLength(2);
});

it('reconciles an echo before the response without rebuilding or flickering the retained transcript', async () => {
  const f = await fixture([user('earlier', 'Earlier prompt')]);
  const transcript = new AgentTranscript({ requestRender: vi.fn() } as unknown as TUI, createClientKeybindings(), undefined, defaultClientTheme);
  cleanups.push(() => transcript.dispose());
  const detach = vi.spyOn(transcript, 'detach');
  transcript.showProjection(f.project());
  const submitting = f.controller.submit('New prompt');
  const pending = f.project();
  transcript.showProjection(pending);
  const before = transcript.render(100);
  f.publish(user('confirmed', 'New prompt'));
  const confirmed = f.project();
  expect(confirmed.messages.at(-1)).toBe(pending.messages.at(-1));
  expect(f.controller.history.at(-1)?.timestamp).toBe(1);
  transcript.showProjection(confirmed);
  expect(transcript.render(100)).toEqual(before);
  f.resolve({ outcome: 'accepted', result: { runId: 'run' } } as ResponseFor<'prompt'>);
  expect(await submitting).toBe(true);
  transcript.showProjection(f.project());
  expect(detach).toHaveBeenCalledTimes(1);
  expect(stripTerminalSequences(transcript.render(100).join('\n')).match(/New prompt/gu)).toHaveLength(1);
});

it.each(['rejected', 'indeterminate'] as const)('removes an echo when submission is %s', async outcome => {
  const f = await fixture();
  const submitting = f.controller.submit('Not accepted');
  expect(f.project().messages).toHaveLength(1);
  f.resolve({ outcome, error: { code: outcome === 'rejected' ? 'busy' : 'indeterminate', message: 'Cannot submit' } } as ResponseFor<'prompt'>);
  expect(await submitting).toBe(false);
  expect(f.project().messages).toEqual([]);
  expect(f.controller.promptEchoes).toEqual([]);
  expect(f.controller.busy).toBe(false);
});

it('removes an echo when the request throws', async () => {
  const f = await fixture();
  const submitting = f.controller.submit('Failed request');
  f.reject(new Error('Connection failed'));
  await expect(submitting).rejects.toThrow('Connection failed');
  expect(f.project().messages).toEqual([]);
  expect(f.controller.busy).toBe(false);
});

it.each(['response-first', 'message-first'] as const)('uses authoritative transformed input after acceptance (%s)', async order => {
  const f = await fixture();
  const submitting = f.controller.submit('Original input');
  f.run('running', 'run');
  if (order === 'message-first') f.publish(user('transformed', 'Input transformed by an extension'));
  f.resolve({ outcome: 'accepted', result: { runId: 'run' } } as ResponseFor<'prompt'>);
  await submitting;
  if (order === 'response-first') f.publish(user('transformed', 'Input transformed by an extension'));
  expect(f.project().messages).toEqual([{ role: 'user', timestamp: 1, content: [{ type: 'text', text: 'Input transformed by an extension' }] }]);
});

it('waits past the preceding idle run and prefers matching text within its own active run', async () => {
  const f = await fixture();
  f.run('idle', 'previous-run');
  const submitting = f.controller.submit('New input');
  f.resolve({ outcome: 'accepted', result: { runId: 'run' } } as ResponseFor<'prompt'>);
  await submitting;
  expect(f.controller.promptEchoes).toHaveLength(1);
  f.run('running', 'run');
  f.publish(user('other', 'Other input'), user('matched', 'New input'));
  expect(f.controller.promptEchoes[0]?.message).toBe('matched');
  expect(f.project().messages).toHaveLength(2);
});

it.each(['idle', 'interrupted'] as const)('drops a consumed prompt when its run becomes %s and binds the next prompt', async settled => {
  const f = await fixture();
  const consumed = f.controller.submit('Consumed by an input hook');
  f.resolve({ outcome: 'accepted', result: { runId: 'run' } } as ResponseFor<'prompt'>);
  await consumed;
  f.run('running', 'run');
  expect(f.controller.promptEchoes).toHaveLength(1);
  f.run(settled);
  expect(f.controller.promptEchoes).toEqual([]);
  expect(f.project().messages).toEqual([]);

  f.client.request.mockResolvedValueOnce({ outcome: 'accepted', result: { runId: 'next-run' } } as ResponseFor<'prompt'>);
  await f.controller.submit('Next prompt');
  f.run('running', 'next-run');
  f.publish(user('next', 'Next prompt'));
  expect(f.controller.promptEchoes.map(echo => echo.message)).toEqual(['next']);
  expect(f.project().messages).toHaveLength(1);
});

it('remembers a consumed run settling before its acknowledgement arrives', async () => {
  const f = await fixture();
  const submitting = f.controller.submit('Consumed input');
  f.run('running', 'run');
  f.run('idle');
  f.resolve({ outcome: 'accepted', result: { runId: 'run' } } as ResponseFor<'prompt'>);
  await submitting;
  expect(f.controller.promptEchoes).toEqual([]);
  f.run('running', 'next-run');
  f.publish(user('later', 'Later input'));
  expect(f.project().messages).toHaveLength(1);
});

it('drops an unconfirmed echo when a later run replaces it without an observed idle state', async () => {
  const f = await fixture();
  const submitting = f.controller.submit('Consumed input');
  f.resolve({ outcome: 'accepted', result: { runId: 'run' } } as ResponseFor<'prompt'>);
  await submitting;
  f.run('running', 'next-run');
  f.publish(user('later', 'Later input'));
  expect(f.controller.promptEchoes).toEqual([]);
  expect(f.project().messages).toHaveLength(1);
});

it('binds two quick prompts in order, preferring matching text over another new user message', async () => {
  const f = await fixture();
  const first = f.controller.submit('First prompt');
  f.resolve({ outcome: 'accepted', result: { runId: 'run' } } as ResponseFor<'prompt'>);
  await first;
  f.client.request.mockResolvedValueOnce({ outcome: 'accepted', result: { runId: 'next-run' } } as ResponseFor<'prompt'>);
  await f.controller.submit('Second prompt');
  f.publish(user('other', 'Other input'), user('first', 'First prompt'), user('second', 'Second prompt'));
  expect(f.controller.promptEchoes.map(echo => echo.message)).toEqual(['first', 'second']);
  expect(f.project().messages).toHaveLength(3);
});

it('does not use a different user message as a fallback after the accepted run settles', async () => {
  const f = await fixture();
  const submitting = f.controller.submit('Consumed input');
  f.resolve({ outcome: 'accepted', result: { runId: 'run' } } as ResponseFor<'prompt'>);
  await submitting;
  f.state.run = { state: 'idle', id: 'run' };
  f.publish(user('other', 'Different input'));
  expect(f.controller.promptEchoes).toEqual([]);
  expect(f.project().messages).toHaveLength(1);
});

it('bounds confirmed echoes while keeping the latest echoed component stable', async () => {
  const f = await fixture();
  f.client.request.mockResolvedValue({ outcome: 'accepted', result: { runId: 'run' } } as ResponseFor<'prompt'>);
  for (let index = 0; index < 40; index++) {
    await f.controller.submit(`Prompt ${index}`);
    const latest = f.project().messages.at(-1);
    f.publish(user(`message-${index}`, `Prompt ${index}`));
    expect(f.project().messages.at(-1)).toBe(latest);
  }
  expect(f.controller.promptEchoes.length).toBeLessThan(40);
  expect(f.controller.promptEchoes.at(-1)?.message).toBe('message-39');
  expect(f.project().messages).toHaveLength(40);
  f.state.branch = 'replacement';
  f.state.history = { revision: 41, branch: 'replacement', entries: [user('replacement', 'Replacement branch')] };
  f.emit();
  expect(f.controller.promptEchoes).toEqual([]);
});

it('drops an unmatched echo when its history branch is replaced', async () => {
  const f = await fixture([user('anchor', 'Original branch')]);
  const submitting = f.controller.submit('Old branch input');
  f.state.branch = 'different';
  f.state.history = { revision: 1, branch: 'different', entries: [user('other-branch', 'Different branch')] };
  f.emit();
  expect(f.controller.promptEchoes).toEqual([]);
  expect(f.project().messages).toHaveLength(1);
  f.resolve({ outcome: 'accepted', result: { runId: 'run' } } as ResponseFor<'prompt'>);
  await submitting;
  expect(f.controller.promptEchoes).toEqual([]);
});

it('clears pending and confirmed echoes on session switches, including while the request is unresolved', async () => {
  const f = await fixture();
  const submitting = f.controller.submit('Old session prompt');
  await f.controller.attach('other');
  expect(f.controller.promptEchoes).toEqual([]);
  expect(f.project().messages).toEqual([]);
  f.resolve({ outcome: 'accepted', result: { runId: 'run' } } as ResponseFor<'prompt'>);
  expect(await submitting).toBe(true);
  expect(f.controller.promptEchoes).toEqual([]);
  await f.controller.attach('session');
  f.publish(user('confirmed', 'Old session prompt'));
  const next = f.controller.submit('Another prompt');
  f.publish(user('next', 'Another prompt'));
  await next;
  expect(f.controller.promptEchoes[0]?.message).toBe('next');
  await f.controller.attach('other');
  expect(f.controller.promptEchoes).toEqual([]);
});

it.each(['steer', 'follow_up'] as const)('leaves %s submissions in the daemon queue instead of echoing them', async kind => {
  const f = await fixture();
  f.state.run = { state: 'running', id: 'run' };
  const submitting = f.controller.submit('Queued input', kind);
  expect(f.project().messages).toEqual([]);
  expect(f.controller.promptEchoes).toEqual([]);
  expect(f.client.request).toHaveBeenCalledWith(kind, { text: 'Queued input' }, { session: 'session' });
  f.resolve({ outcome: 'accepted', result: { runId: 'run' } } as ResponseFor<'prompt'>);
  expect(await submitting).toBe(true);
});

it('keeps paged history, repeated text and note anchors separate from the pending echo', async () => {
  const f = await fixture([user('anchor', 'Last retained')]);
  f.controller.announce('After retained');
  const submitting = f.controller.submit('Repeated text');
  f.state.history.cursor = 'older';
  f.client.request.mockResolvedValueOnce({ outcome: 'accepted', result: { entries: [user('older', 'Repeated text')] } } as never);
  await f.controller.loadHistory();
  expect(f.controller.history.map(message => message.id)).toEqual(['older', 'anchor']);
  expect(f.controller.promptEchoes[0]?.message).toBeUndefined();
  expect(f.project().notes).toEqual([{ before: 2, text: 'After retained', level: 'info' }]);
  expect(f.project().messages).toHaveLength(3);
  f.state.history.cursor = undefined;
  f.publish(user('confirmed', 'Repeated text'));
  expect(f.controller.history.map(message => message.id)).toEqual(['older', 'anchor', 'confirmed']);
  expect(f.controller.promptEchoes[0]?.message).toBe('confirmed');
  expect(f.project().messages).toHaveLength(3);
  expect(f.project().notes).toEqual([{ before: 2, text: 'After retained', level: 'info' }]);
  f.resolve({ outcome: 'accepted', result: { runId: 'run' } } as ResponseFor<'prompt'>);
  await submitting;
});

it.each(['rejected', 'indeterminate'] as const)('renders local echo on screen and restores editor input after %s', async outcome => {
  const f = await fixture();
  setKeybindings(createClientKeybindings());
  const tui = new TuiAltScreen(new TestTerminal());
  const screen = new DaemonTuiScreen(f.controller, tui, { cwd: '/fixture', exit: vi.fn() });
  tui.setLayoutRoot(screen.component); screen.focus(); tui.start();
  cleanups.push(async () => { await screen.dispose(); tui.stop(); });
  screen.editor.setText('Visible immediately');
  const submitting = screen.submit('Visible immediately');
  tui.renderNow(true);
  expect(screen.editor.getText()).toBe('');
  expect(stripTerminalSequences(tui.getScreenLines().join('\n')).match(/Visible immediately/gu)).toHaveLength(1);
  f.resolve({ outcome, error: { code: outcome === 'rejected' ? 'busy' : 'indeterminate', message: 'Cannot submit' } } as ResponseFor<'prompt'>);
  await submitting;
  tui.renderNow(true);
  expect(screen.editor.getText()).toBe('Visible immediately');
  expect(stripTerminalSequences(screen.transcript.render(100).join('\n'))).not.toContain('Visible immediately');
});

class TestTerminal implements Terminal {
  columns = 100; rows = 24; kittyProtocolActive = false;
  start(): void {}
  stop(): void {}
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
