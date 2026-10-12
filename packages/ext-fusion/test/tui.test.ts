import type { Theme } from '@felan-ai/agent-core';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import { FusionModelPicker, FusionReviewPanel, presentFusionReview, presentFusionDecision, presentFusionModelPicker } from '../src/tui.js';
import type { FusionReview, FusionReviewActions } from '../src/contracts.js';

const theme = {
  fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text,
  bold: (text: string) => text, italic: (text: string) => text,
  underline: (text: string) => text, strikethrough: (text: string) => text,
} as unknown as Theme;
const models = [{ reference: 'one/model', label: 'One' }, { reference: 'two/model', label: 'Two' }];
const review: FusionReview = {
  prompt: 'Compare approaches', participants: models.map(model => model.reference), fusionModel: 'one/model',
  answers: models.map(model => ({ model: model.reference, text: `Answer from ${model.label}`, durationMs: 10 })),
  comparison: { model: 'one/model', text: 'The comparison', durationMs: 10 },
  failures: [{ model: 'unavailable/model', message: 'Request failed' }], updatedAt: 1,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(overrides: Partial<FusionReviewActions> = {}) {
  const actions = { fuse: vi.fn(async () => {}), retryParticipants: vi.fn(async () => {}),
    retryComparison: vi.fn(async () => {}), retryFusion: vi.fn(async () => {}), cancel: vi.fn(), ...overrides };
  const notify = vi.fn(); const done = vi.fn(); const render = vi.fn();
  const panel = new FusionReviewPanel({ getModels: () => models, notify }, () => review, actions, theme, render, done, () => 30);
  panel.focused = true;
  return { panel, actions, notify, done, render };
}

describe('Fusion presenters', () => {
  it('keeps comparison pages and never fuses merely by opening the review', () => {
    const h = harness();
    expect(h.panel.render(80).join('\n')).toContain('The comparison');
    h.panel.handleInput('\x1b[C');
    expect(h.panel.render(80).join('\n')).toContain('Answer from One');
    h.panel.handleInput('\x1b');
    expect(h.done).toHaveBeenCalledOnce(); expect(h.actions.fuse).not.toHaveBeenCalled();
  });

  it('waits for explicitly selected fusion after the review closes', async () => {
    const pending = deferred(); const fuse = vi.fn(() => pending.promise);
    const h = harness({ fuse }); h.panel.handleInput('f');
    expect(fuse).toHaveBeenCalledWith(undefined, undefined); expect(h.done).toHaveBeenCalledOnce();
    expect(h.panel.pendingAction).toBeInstanceOf(Promise);
    pending.resolve(); await h.panel.pendingAction;
  });

  it('keeps retry busy and cancels the owning action from Escape', async () => {
    const pending = deferred(); const h = harness({ retryParticipants: () => pending.promise });
    h.panel.handleInput('r'); expect(h.panel.render(80).join('\n')).toContain('Working');
    h.panel.handleInput('f'); expect(h.actions.fuse).not.toHaveBeenCalled();
    h.panel.handleInput('\x1b'); expect(h.actions.cancel).toHaveBeenCalledOnce();
    expect(h.done).toHaveBeenCalledOnce(); pending.resolve(); await pending.promise;
  });

  it('passes optional instructions and an explicitly selected allowed model', async () => {
    const h = harness(); h.panel.handleInput('F'); h.panel.handleInput('Prefer simplicity'); h.panel.handleInput('\r');
    h.panel.handleInput('\x1b[B'); h.panel.handleInput('\r'); h.panel.handleInput('\x13');
    expect(h.actions.fuse).toHaveBeenCalledWith('Prefer simplicity', 'two/model');
    await h.panel.pendingAction;
  });

  it('keeps invalid saved lineup choices out of a completed selection', () => {
    const done = vi.fn();
    const picker = new FusionModelPicker({ models, participants: ['missing/model', 'one/model'], fusionModel: 'inherit' }, theme, done);
    picker.handleInput('\x13'); expect(done).not.toHaveBeenCalled();
    expect(picker.render(80).join('\n')).toContain('unavailable');
    picker.handleInput('\x1b'); expect(done).toHaveBeenCalledWith(undefined);
  });

  it('preserves selected participant order and the inherited comparison model', () => {
    const done = vi.fn();
    const picker = new FusionModelPicker({ models, participants: ['two/model', 'one/model'], fusionModel: 'inherit' }, theme, done);
    picker.handleInput('\x13');
    expect(done).toHaveBeenCalledWith({ participants: ['two/model', 'one/model'], fusionModel: 'inherit' });
  });

  it('uses only the client UI port and joins synthesis before returning', async () => {
    const pending = deferred(); const h = harness({ fuse: () => pending.promise });
    let returned = false;
    const custom = vi.fn((factory: (...args: any[]) => any) => new Promise<void>(resolve => {
      const panel = factory({ requestRender: vi.fn(), terminal: { rows: 30 } }, theme, {}, resolve);
      panel.handleInput('f');
    }));
    const presentation = presentFusionReview({ custom: custom as never, notify: h.notify }, () => models, () => review, h.actions).then(() => { returned = true; });
    await Promise.resolve(); expect(returned).toBe(false);
    pending.resolve(); await presentation; expect(returned).toBe(true);
    expect(custom).toHaveBeenCalledOnce();
  });

  it.each(['r', 'c'])('joins a cancelled retry before returning: %s', async key => {
    const pending = deferred();
    const h = harness({ retryParticipants: () => pending.promise, retryComparison: () => pending.promise });
    let returned = false;
    const custom = (factory: (...args: any[]) => any) => new Promise<void>(resolve => {
      const panel = factory({ requestRender: vi.fn(), terminal: { rows: 30 } }, theme, {}, resolve);
      panel.handleInput(key); panel.handleInput('\x1b');
    });
    const presentation = presentFusionReview({ custom: custom as never, notify: h.notify }, () => models, () => review, h.actions).then(() => { returned = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.actions.cancel).toHaveBeenCalledOnce(); expect(returned).toBe(false);
    pending.resolve(); await presentation; expect(returned).toBe(true);
  });

  it('cancels and joins work if the client UI fails', async () => {
    const pending = deferred(); const cancel = vi.fn(pending.resolve);
    const h = harness({ retryComparison: () => pending.promise, cancel });
    const custom = async (factory: (...args: any[]) => any) => {
      const panel = factory({ requestRender: vi.fn(), terminal: { rows: 30 } }, theme, {}, vi.fn());
      panel.handleInput('c'); throw new Error('UI closed');
    };
    await expect(presentFusionReview({ custom: custom as never, notify: h.notify }, () => models, () => review, h.actions)).rejects.toThrow('UI closed');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('emits a typed options decision without discovering or running models', async () => {
    const custom = (factory: (...args: any[]) => any) => new Promise(resolve => {
      const panel = factory({ requestRender: vi.fn(), terminal: { rows: 30 } }, theme, {}, resolve);
      panel.handleInput('F'); panel.handleInput('Prefer simplicity'); panel.handleInput('\r');
    });
    await expect(presentFusionDecision({ custom: custom as never, notify: vi.fn() }, review, false, new AbortController().signal))
      .resolves.toEqual({ action: 'choose_model', instruction: 'Prefer simplicity' });
  });

  it('retains invalid instruction text for correction', async () => {
    let panel!: FusionReviewPanel;
    const custom = (factory: (...args: any[]) => any) => new Promise(resolve => {
      panel = factory({ requestRender: vi.fn(), terminal: { rows: 30 } }, theme, {}, resolve);
    });
    const control = new AbortController();
    let reject = true;
    const pending = presentFusionDecision({ custom: custom as never, notify: vi.fn() }, review, false, control.signal, () => reject ? 'Too large' : undefined);
    panel.handleInput('F'); panel.handleInput('Retain this'); panel.handleInput('\r');
    expect(panel.render(80).join('\n')).toContain('Too large');
    expect(panel.render(80).map(stripTerminalSequences).join('\n')).toContain('Retain this');
    reject = false; panel.handleInput('!'); panel.handleInput('\r');
    await expect(pending).resolves.toEqual({ action: 'choose_model', instruction: 'Retain this!' });
  });

  it('limits a busy review to cancellation', async () => {
    const custom = (factory: (...args: any[]) => any) => new Promise(resolve => {
      const panel = factory({ requestRender: vi.fn(), terminal: { rows: 30 } }, theme, {}, resolve);
      panel.handleInput('f'); expect(panel.render(80).join('\n')).toContain('Working'); panel.handleInput('\x1b');
    });
    await expect(presentFusionDecision({ custom: custom as never, notify: vi.fn() }, review, true, new AbortController().signal))
      .resolves.toEqual({ action: 'close' });
  });

  it('does not open an already-aborted model picker', async () => {
    const custom = vi.fn();
    await expect(presentFusionModelPicker({ custom }, { models, participants: [], fusionModel: 'inherit' }, AbortSignal.abort())).resolves.toBeUndefined();
    expect(custom).not.toHaveBeenCalled();
  });
});
