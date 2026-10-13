import { describe, expect, it, vi } from 'vitest';
import { parseInteraction, type Interaction } from '@felan-ai/session-protocol';
import { ClientInteractionPresenters, type InteractionPresenterUi } from '../src/client/presenters.js';

function fixture() {
  const ui = { select: vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined), confirm: vi.fn(async () => false),
    input: vi.fn(async (): Promise<string | undefined> => undefined), editor: vi.fn(async (): Promise<string | undefined> => undefined),
    custom: vi.fn(async (): Promise<unknown> => null), notify: vi.fn(), onTerminalInput: vi.fn(() => () => {}) };
  return { ui, presenters: new ClientInteractionPresenters(ui as unknown as InteractionPresenterUi), signal: new AbortController().signal };
}

function interaction(request: Interaction['request']): Interaction {
  return parseInteraction({ id: 'interaction', state: 'waiting', scope: { kind: 'session', session: 'session', root: 'session' },
    createdAt: Date.now(), request });
}

describe('client interaction presenters', () => {
  it('renders supported broker-approved interactions without treating legacy kind labels as authority', async () => {
    const f = fixture();
    const item = { ...interaction({ kind: 'confirm', title: 'Owner approval', message: 'Continue?' }),
      authority: 'owner' as const };
    await expect(f.presenters.present(item, f.signal)).resolves.toMatchObject({ state: 'answered', answer: { kind: 'confirm', confirmed: false } });
    expect(f.ui.confirm).toHaveBeenCalledOnce();
    await expect(f.presenters.present({ ...item, state: 'cancelled', resolvedAt: Date.now(), result: { cancelled: true, reason: 'user' } }, f.signal)).resolves.toMatchObject({ state: 'unsupported' });
    expect(f.ui.confirm).toHaveBeenCalledOnce();
  });

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

  it('maps multi-select answers back to protocol IDs', async () => {
    const f = fixture();
    f.ui.custom.mockResolvedValueOnce([{ questionId: 'selection', response: { kind: 'selection', selections: ['1. Same', '2. Same'] } }]);
    await expect(f.presenters.present(interaction({ kind: 'select', title: 'Pick', multiple: true,
      choices: [{ id: 'a', title: 'Same' }, { id: 'b', title: 'Same' }] }), f.signal)).resolves.toMatchObject({ answer: { kind: 'select', choices: ['a', 'b'] } });
  });

  it('distinguishes abort, expiry, user cancellation and unsupported workflows', async () => {
    const f = fixture(); const item = interaction({ kind: 'input', title: 'Name' });
    const controller = new AbortController(); controller.abort();
    await expect(f.presenters.present(item, controller.signal)).resolves.toEqual({ state: 'cancelled', reason: 'abort' });
    await expect(f.presenters.present({ ...item, createdAt: 0, expiresAt: 1 }, f.signal)).resolves.toEqual({ state: 'cancelled', reason: 'timeout' });
    expect(f.ui.input).not.toHaveBeenCalled();
    await expect(f.presenters.present(item, f.signal)).resolves.toEqual({ state: 'cancelled', reason: 'user' });
  });
});
