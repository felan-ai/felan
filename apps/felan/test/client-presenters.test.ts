import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { RUNTIME_UI_PRESENTER, parseInteraction, type Interaction } from '@felan-ai/session-protocol';
import { ClientInteractionPresenters, runtimeUiState, type InteractionPresenterUi } from '../src/client/presenters.js';

function fixture() {
  const ui = { select: vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined), confirm: vi.fn(async () => false),
    input: vi.fn(async (): Promise<string | undefined> => undefined), editor: vi.fn(async (): Promise<string | undefined> => undefined),
    custom: vi.fn(async (): Promise<unknown> => null), notify: vi.fn(), onTerminalInput: vi.fn(() => () => {}) };
  return { ui, presenters: new ClientInteractionPresenters(ui as unknown as InteractionPresenterUi), signal: new AbortController().signal };
}

function interaction(request: Interaction['request']): Interaction {
  return parseInteraction({ id: 'interaction', state: 'waiting', scope: { kind: 'session', session: 'session', root: 'session' },
    createdAt: Date.now(), eligibleClientKinds: ['tui'], request });
}

describe('client interaction presenters', () => {
  it('preserves choice identity even when displayed labels repeat', async () => {
    const f = fixture(); f.ui.select.mockImplementation(async (_title, labels) => (labels as string[])[1]);
    const item = interaction({ kind: 'select', title: 'Pick', multiple: false, choices: [{ id: 'first', title: 'Same' }, { id: 'second', title: 'Same' }] });
    await expect(f.presenters.present(item, f.signal)).resolves.toEqual({ state: 'answered', answer: { kind: 'select', choices: ['second'] } });
  });

  it('maps confirmations, input and editor answers without an execution runtime', async () => {
    const f = fixture();
    await expect(f.presenters.present(interaction({ kind: 'confirm', title: 'Confirm', message: 'Proceed?' }), f.signal))
      .resolves.toMatchObject({ answer: { kind: 'confirm', confirmed: false } });
    f.ui.input.mockResolvedValueOnce('typed');
    await expect(f.presenters.present(interaction({ kind: 'input', title: 'Name', initialValue: 'existing' }), f.signal)).resolves.toMatchObject({ answer: { text: 'typed' } });
    expect(f.ui.input).toHaveBeenLastCalledWith('Name', undefined, expect.objectContaining({ initialValue: 'existing' }));
    f.ui.editor.mockResolvedValueOnce('edited');
    await expect(f.presenters.present(interaction({ kind: 'editor', title: 'Edit', initialValue: 'before' }), f.signal)).resolves.toMatchObject({ answer: { text: 'edited' } });
  });

  it('shows approval details and strips terminal control sequences from labels', async () => {
    const f = fixture(); f.ui.select.mockImplementation(async (_title, labels) => (labels as string[])[0]);
    await expect(f.presenters.present(interaction({ kind: 'tool_approval', toolCallId: 'call', toolName: 'bash', summary: 'rm example',
      options: [{ id: 'reject', title: '\u001b[31mReject\u001b[0m' }] }), f.signal)).resolves.toMatchObject({ answer: { optionId: 'reject' } });
    expect(f.ui.select.mock.calls[0]?.[0]).toContain('rm example');
    expect(f.ui.select.mock.calls[0]?.[1]).toEqual(['1. Reject']);
  });

  it('maps rich wizard and multi-select answers back to protocol IDs', async () => {
    const f = fixture();
    f.ui.custom.mockResolvedValueOnce([{ questionId: 'q', response: { kind: 'selection', selections: ['2. Same'], comment: 'why' } }]);
    await expect(f.presenters.present(interaction({ kind: 'ask_user', questions: [{ id: 'q', question: 'Pick?', allowComment: true,
      options: [{ id: 'a', title: 'Same' }, { id: 'b', title: 'Same' }] }] }), f.signal)).resolves.toMatchObject({ answer: { kind: 'ask_user', answers: [{ questionId: 'q', choices: ['b'], comment: 'why' }] } });
    f.ui.custom.mockResolvedValueOnce([{ questionId: 'selection', response: { kind: 'selection', selections: ['1. Same', '2. Same'] } }]);
    await expect(f.presenters.present(interaction({ kind: 'select', title: 'Pick', multiple: true,
      choices: [{ id: 'a', title: 'Same' }, { id: 'b', title: 'Same' }] }), f.signal)).resolves.toMatchObject({ answer: { kind: 'select', choices: ['a', 'b'] } });
  });

  it('negotiates exact custom versions and rejects missing handlers visibly', async () => {
    const f = fixture(); const custom = vi.fn(async () => ({ selected: 'yes' }));
    expect(f.presenters.interactionKinds).not.toContain('custom');
    const remove = f.presenters.registerCustom({ id: 'test', version: '1' }, custom);
    expect(f.presenters.interactionKinds).toContain('custom');
    expect(f.presenters.presenters).toContainEqual({ id: 'test', version: '1' });
    await expect(f.presenters.present(interaction({ kind: 'custom', presenter: { version: '1', id: 'test' }, data: {} }), f.signal))
      .resolves.toMatchObject({ state: 'answered', answer: { data: { selected: 'yes' } } });
    await expect(f.presenters.present(interaction({ kind: 'custom', presenter: { id: 'test', version: '2' }, data: {} }), f.signal))
      .resolves.toMatchObject({ state: 'unsupported' });
    expect(custom).toHaveBeenCalledTimes(1); expect(f.ui.notify).toHaveBeenCalled();
    remove(); expect(f.presenters.interactionKinds).not.toContain('custom');
    expect(() => f.presenters.registerCustom(RUNTIME_UI_PRESENTER, custom)).toThrow('already registered');
  });

  it('distinguishes abort, expiry, user cancellation and unsupported workflows', async () => {
    const f = fixture(); const item = interaction({ kind: 'input', title: 'Name' });
    const controller = new AbortController(); controller.abort();
    await expect(f.presenters.present(item, controller.signal)).resolves.toEqual({ state: 'cancelled', reason: 'abort' });
    await expect(f.presenters.present({ ...item, createdAt: 0, expiresAt: 1 }, f.signal)).resolves.toEqual({ state: 'cancelled', reason: 'timeout' });
    expect(f.ui.input).not.toHaveBeenCalled();
    await expect(f.presenters.present(item, f.signal)).resolves.toEqual({ state: 'cancelled', reason: 'user' });
    await expect(f.presenters.present(interaction({ kind: 'oauth', provider: 'fixture', provisioningId: 'setup', url: 'https://example.invalid', instructions: 'Sign in' }), f.signal))
      .resolves.toMatchObject({ state: 'unsupported' });
  });

  it('parses only the supported runtime presentation version', () => {
    expect(runtimeUiState({ id: 'state', kind: 'custom', presenter: RUNTIME_UI_PRESENTER, data: { workingVisible: false } })).toEqual({ workingVisible: false });
    expect(runtimeUiState({ id: 'state', kind: 'custom', presenter: { ...RUNTIME_UI_PRESENTER, version: '2' }, data: {} })).toBeUndefined();
    expect(() => runtimeUiState({ id: 'state', kind: 'custom', presenter: RUNTIME_UI_PRESENTER, data: { unknown: true } })).toThrow();
    expect(readFileSync(new URL('../src/client/presenters.ts', import.meta.url), 'utf8')).not.toMatch(/from\s+['"][^'"]*(?:daemon|\/runtime)/);
    expect(readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')).not.toContain('presenters.js');
  });
});
