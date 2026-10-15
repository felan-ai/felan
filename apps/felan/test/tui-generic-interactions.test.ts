import { afterEach, expect, it, vi } from 'vitest';
import type { UiActionRequest, UiPresentation, UiDocument } from '@felan-ai/session-protocol';
import { TerminalInteractions } from '../src/tui/interactions.js';
import type { TuiSessionController } from '../src/tui/controller.js';
import type { ClientInteractionPresenters } from '../src/client/presenters.js';
import { createSessionState, type SessionState } from '../src/client/reducer.js';
import { GENERIC_UI_CAPABILITIES } from '../src/client/ui.js';
import { snapshot } from './client-fixtures.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const document = (revision = 1): UiDocument => ({ id: 'doc', kind: 'document', revision, title: 'Document', markdown: 'Read this', fallback: 'Read document',
  actions: [{ id: 'refresh', label: 'Refresh', target: 'element', outcome: 'submit' }] });

function fixture(capable = true, initial: UiPresentation = document(), inPlace = false) {
  let status = 'ready';
  let state: SessionState = { ...createSessionState('session'), status: 'live', snapshot: { ...snapshot(), presentation: [initial] } };
  const listeners = new Set<() => void>(); const emit = () => { for (const listener of [...listeners]) listener(); };
  const pending: Array<{ source: UiPresentation; signal: AbortSignal; resolve: (value: UiActionRequest | undefined) => void }> = [];
  const presentElement = vi.fn((source: UiPresentation, signal: AbortSignal, _interactive: boolean) => new Promise<UiActionRequest | undefined>(resolve => {
    pending.push({ source, signal, resolve }); signal.addEventListener('abort', () => resolve(undefined), { once: true });
  }));
  const updateElement = vi.fn((source: UiPresentation, signal: AbortSignal) => {
    const row = pending.find(item => item.signal === signal);
    if (!inPlace || !row) return false;
    row.source = source; return true;
  });
  const perform = vi.fn(async () => ({ outcome: 'accepted', result: {} }));
  const notice = vi.fn(() => emit());
  const controller = {
    sessionId: 'session', get state() { return state; }, get snapshot() { return state.snapshot; },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setNotice: notice, perform,
    client: { get status() { return status; }, capabilities: { capabilities: capable ? [...GENERIC_UI_CAPABILITIES] : [], operations: capable ? ['ui.action'] : [] },
      getInteractions: () => [], getAttachment: () => ({ state }) },
  } as unknown as TuiSessionController;
  const interactions = new TerminalInteractions(controller, { presentElement, updateElement } as unknown as ClientInteractionPresenters);
  cleanups.push(() => interactions.dispose());
  const answer = (index: number) => { const row = pending[index]!;
    if (!('revision' in row.source)) throw new Error('Statuses have no actions.');
    row.resolve({ elementId: row.source.id, revision: row.source.revision, actionId: 'refresh', outcome: 'submit', values: {} }); };
  return { pending, perform, presentElement, notice, answer, interactions,
    update: (next: SessionState['status'], connected = 'ready', doc: UiPresentation = initial) => {
      status = connected; state = { ...state, status: next, snapshot: { ...snapshot(), presentation: [doc] } }; emit();
    } };
}

it('aborts stale dialogs and submits only the latest declared action revision', async () => {
  const f = fixture(); await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  f.update('live', 'ready', document(2));
  await vi.waitFor(() => expect(f.pending).toHaveLength(2));
  expect(f.pending[0]?.signal.aborted).toBe(true);
  f.answer(0); f.answer(1);
  await vi.waitFor(() => expect(f.perform).toHaveBeenCalledOnce());
  expect(f.perform).toHaveBeenCalledWith('ui.action', { elementId: 'doc', revision: 2, actionId: 'refresh', outcome: 'submit', values: {} }, 'session');
});

it('holds an answer during snapshot recovery and checks it again after recovery', async () => {
  const f = fixture(); await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  f.update('recovering'); f.answer(0);
  await Promise.resolve(); expect(f.perform).not.toHaveBeenCalled();
  f.update('live'); await vi.waitFor(() => expect(f.perform).toHaveBeenCalledOnce());
});

it('keeps the unresolved element through disconnect and commits its current action after reconnect', async () => {
  const f = fixture(); await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  f.update('disconnected', 'disconnected');
  expect(f.pending[0]?.signal.aborted).toBe(false);
  f.answer(0); await Promise.resolve(); expect(f.perform).not.toHaveBeenCalled();
  f.update('live'); await vi.waitFor(() => expect(f.perform).toHaveBeenCalledOnce());
  expect(f.pending).toHaveLength(1);
});

it('displays a read-only fallback without invoking unnegotiated actions', async () => {
  const f = fixture(false); await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  expect(f.presentElement.mock.calls[0]?.[2]).toBe(false);
  f.pending[0]!.resolve(undefined); await Promise.resolve();
  expect(f.perform).not.toHaveBeenCalled();
});

it('keeps passive documents discoverable without opening recurring dialogs and restores an explicitly opened view', async () => {
  const source = { ...document(), actions: [] };
  const f = fixture(true, source);
  await Promise.resolve(); expect(f.pending).toHaveLength(0);
  expect(f.interactions.elements()).toEqual([source]);
  f.interactions.showElement('doc'); await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  f.update('disconnected', 'disconnected');
  expect(f.pending[0]?.signal.aborted).toBe(false);
  f.update('live'); f.pending[0]!.resolve(undefined); await vi.waitFor(() => expect(f.interactions.busy).toBe(false));
  f.interactions.showElement('doc'); await vi.waitFor(() => expect(f.pending).toHaveLength(2));
  f.pending[1]!.resolve(undefined); expect(f.perform).not.toHaveBeenCalled();
});

it('opens typed statuses for full inspection without inventing a revision or action', async () => {
  const f = fixture(true, { id: 'status', kind: 'status', key: 'tokens', value: { kind: 'tokens', value: 42 }, fallback: '42 tokens' });
  expect(f.pending).toHaveLength(0);
  f.interactions.showElement('status'); await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  f.pending[0]!.resolve(undefined); await vi.waitFor(() => expect(f.interactions.busy).toBe(false));
  expect(f.perform).not.toHaveBeenCalled();
});


it('keeps live-updatable presentations mounted and submits their current revision', async () => {
  const f = fixture(true, document(), true);
  await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  f.update('live', 'ready', document(2));
  expect(f.presentElement).toHaveBeenCalledOnce();
  expect(f.pending[0]!.signal.aborted).toBe(false);
  expect(f.interactions.busy).toBe(true);
  f.answer(0);
  await vi.waitFor(() => expect(f.perform).toHaveBeenCalledOnce());
  expect(f.perform).toHaveBeenCalledWith('ui.action', expect.objectContaining({ revision: 2 }), 'session');
});
