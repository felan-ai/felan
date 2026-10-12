import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { LIMITS, RUNTIME_UI_PRESENTER, type Presentation } from '@felan-ai/session-protocol';
import type { BrokerOutcome, InteractionBroker } from '../src/daemon/broker.js';
import { createSessionExtensionUi, UnsupportedExtensionUiError } from '../src/daemon/extension-ui.js';

function fixture() {
  const request = vi.fn<InteractionBroker['request']>(async (): Promise<BrokerOutcome> => ({ state: 'cancelled', reason: 'user' }));
  const bridge = createSessionExtensionUi({ broker: { request } as unknown as InteractionBroker,
    scope: { kind: 'session', session: 'session', root: 'root' } });
  const updates: Array<Presentation | { id: string; remove: true }> = [];
  return { ...bridge, request, updates, activate: () => bridge.activate(update => updates.push(update)) };
}

describe('session extension UI bridge', () => {
  it('maps all four dialogs to bounded broker requests', async () => {
    const f = fixture(); f.activate();
    f.request.mockResolvedValueOnce({ state: 'answered', answer: { kind: 'select', choices: ['1'] } });
    await expect(f.context.select('Pick', ['One', 'Two'])).resolves.toBe('Two');
    expect(f.request.mock.calls[0]?.[0]).toEqual({ kind: 'select', title: 'Pick', multiple: false, choices: [{ id: '0', title: 'One' }, { id: '1', title: 'Two' }] });
    f.request.mockResolvedValueOnce({ state: 'answered', answer: { kind: 'confirm', confirmed: true } });
    await expect(f.context.confirm('Confirm', 'Proceed?')).resolves.toBe(true);
    f.request.mockResolvedValueOnce({ state: 'answered', answer: { kind: 'input', text: 'Text' } });
    await expect(f.context.input('Input', 'Placeholder')).resolves.toBe('Text');
    f.request.mockResolvedValueOnce({ state: 'answered', answer: { kind: 'editor', text: 'After' } });
    await expect(f.context.editor('Edit', 'Before')).resolves.toBe('After');
    f.dispose();
  });

  it('returns the existing cancellation shapes and propagates dismissal signals', async () => {
    const f = fixture(); f.activate();
    const controller = new AbortController();
    await expect(f.context.select('Pick', ['One'], { signal: controller.signal, timeout: 1.5 })).resolves.toBeUndefined();
    await expect(f.context.confirm('Confirm', 'Proceed?')).resolves.toBe(false);
    await expect(f.context.input('Input')).resolves.toBeUndefined();
    await expect(f.context.editor('Edit')).resolves.toBeUndefined();
    const options = (f.request.mock.calls as unknown as Array<[unknown, unknown, { signal: AbortSignal; timeout?: number }]>)[0]![2];
    expect(options.timeout).toBe(2);
    controller.abort(); expect(options.signal.aborted).toBe(true);
    f.dispose();
  });

  it('buffers only current bounded presentation until activation', async () => {
    const f = fixture();
    f.context.setStatus('keep', 'First'); f.context.setStatus('keep', '\u001b[31mSecond\u001b[0m\u0000');
    f.context.setStatus('remove', 'Gone'); f.context.setStatus('remove', undefined);
    f.context.setWidget('widget', ['One', 'Two'], { placement: 'belowEditor' });
    f.context.setTitle('Title');
    expect(f.updates).toHaveLength(0);
    await expect(f.context.input('Too early')).rejects.toMatchObject({ code: 'unavailable' });
    f.activate();
    expect(f.updates).toHaveLength(3);
    expect(f.updates).toContainEqual(expect.objectContaining({ kind: 'status', text: 'Second' }));
    expect(f.updates).toContainEqual(expect.objectContaining({ kind: 'widget', text: 'One\nTwo', placement: 'belowEditor' }));
    expect(() => f.activate()).toThrow('already active');
    f.dispose();
  });

  it('publishes declarative working state and resets without a terminal object', () => {
    const f = fixture(); f.activate();
    f.context.setWorkingMessage('Indexing'); f.context.setWorkingVisible(false);
    f.context.setWorkingIndicator({ frames: ['.', '..'], intervalMs: 100 });
    f.context.setHiddenThinkingLabel('Thinking'); f.context.setToolsExpanded(true);
    expect(f.context.getToolsExpanded()).toBe(true);
    expect(f.updates.at(-1)).toMatchObject({ kind: 'custom', presenter: RUNTIME_UI_PRESENTER,
      data: { workingMessage: 'Indexing', workingVisible: false, workingIndicator: { frames: ['.', '..'], intervalMs: 100 }, hiddenThinkingLabel: 'Thinking', toolsExpanded: true } });
    f.context.setWorkingMessage(); f.context.setWorkingIndicator(); f.context.setHiddenThinkingLabel();
    expect(f.updates.at(-1)).toMatchObject({ data: { workingVisible: false, toolsExpanded: true } });
    expect(() => f.context.setWorkingIndicator({ intervalMs: 0 })).toThrow();
    f.dispose();
  });

  it('fails explicitly for every non-serializable UI category without invoking callbacks', async () => {
    const f = fixture(); f.activate(); const callback = vi.fn();
    const unsupported = [() => f.context.onTerminalInput(callback), () => f.context.setFooter(callback),
      () => f.context.setHeader(callback), () => f.context.custom(callback), () => f.context.setWidget('custom', callback),
      () => f.context.pasteToEditor('x'), () => f.context.setEditorText('x'), () => f.context.getEditorText(),
      () => f.context.addAutocompleteProvider(callback), () => f.context.setEditorComponent(callback),
      () => f.context.getEditorComponent(), () => f.context.theme.fg('text', 'x'),
      () => f.context.getAllThemes(), () => f.context.getTheme('dark'), () => f.context.setTheme('dark')];
    for (const action of unsupported) await expect(Promise.resolve().then(action)).rejects.toBeInstanceOf(UnsupportedExtensionUiError);
    expect(callback).not.toHaveBeenCalled();
    expect(f.updates.at(-1)).toMatchObject({ kind: 'notification', level: 'warning' });
    expect(() => ({ ...f.context })).not.toThrow();
    f.dispose();
  });

  it('bounds startup state and rejects all work after disposal', async () => {
    const f = fixture();
    for (let i = 0; i < LIMITS.pageEntries; i++) f.context.setStatus(String(i), 'value');
    expect(() => f.context.setStatus('overflow', 'value')).toThrow('capacity');
    f.activate(); expect(f.updates).toHaveLength(LIMITS.pageEntries);
    f.dispose();
    expect(() => f.context.notify('late')).toThrow('disposed');
    await expect(f.context.input('late')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('does not import a renderer or the client application', () => {
    const source = readFileSync(new URL('../src/daemon/extension-ui.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from\s+['"][^'"]*(?:pi-tui|\/felan|InteractiveMode)/);
  });
});
