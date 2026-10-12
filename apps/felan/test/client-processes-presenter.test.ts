import { expect, it, vi } from 'vitest';
import type { Interaction, JsonValue } from '@felan-ai/session-protocol';
import { PROCESS_VIEW_PRESENTER, type ProcessViewRequest } from '@felan-ai/ext-background-bash/view';
import { ClientInteractionPresenters, type InteractionPresenterUi } from '../src/client/presenters.js';
import { registerProcessesPresenter } from '../src/client/processes-presenter.js';

const state: ProcessViewRequest = { viewId: 'view', sequence: 1, offset: 0, total: 2, running: 2, jobs: [1, 2].map(id => ({
  id: `job-${id}`, command: 'echo test', commandTruncated: false, status: 'running', startedAt: 1, updatedAt: 1,
})) };
function interaction(data: ProcessViewRequest): Interaction {
  return { id: `interaction-${data.sequence}`, state: 'waiting', createdAt: Date.now(), eligibleClientKinds: ['tui'],
    scope: { kind: 'session', session: 'session', root: 'session' }, request: { kind: 'custom', presenter: PROCESS_VIEW_PRESENTER, data: data as unknown as JsonValue } };
}

it('presents process navigation, restores selection and aborts on unregister', async () => {
  let panel: { handleInput(key: string): void; render(width: number): string[] } | undefined;
  const custom = vi.fn((factory: (...args: unknown[]) => unknown) => new Promise(resolve => {
    panel = factory({ requestRender() {} }, { fg: (_key: string, text: string) => text, bold: (text: string) => text }, {}, resolve) as typeof panel;
  }));
  const ui = { custom, notify: vi.fn() } as unknown as InteractionPresenterUi;
  const presenters = new ClientInteractionPresenters(ui); const remove = registerProcessesPresenter(presenters, ui);
  try {
    const first = presenters.present(interaction(state), new AbortController().signal);
    await vi.waitFor(() => expect(panel).toBeDefined());
    panel!.handleInput('\u001b[B'); panel!.handleInput('\r'); panel!.handleInput('k');
    expect(await first).toMatchObject({ state: 'answered', answer: { data: { action: 'detail', id: 'job-2', sequence: 1 } } });
    panel = undefined;
    const second = presenters.present(interaction({ ...state, sequence: 2, selectedId: 'job-2', detail: { id: 'job-2', index: 0, chunks: 1, text: 'process output' } }), new AbortController().signal);
    await vi.waitFor(() => expect(panel).toBeDefined()); expect(panel!.render(100).join('\n')).toContain('process output');
    panel!.handleInput('\u001b[D'); expect(await second).toMatchObject({ state: 'answered', answer: { data: { action: 'list' } } });
    panel = undefined;
    const third = presenters.present(interaction({ ...state, sequence: 3, selectedId: 'job-2' }), new AbortController().signal);
    await vi.waitFor(() => expect(panel).toBeDefined()); expect(panel!.render(100).join('\n')).toContain('▶ job-2');
    remove(); expect(await third).toMatchObject({ state: 'cancelled' });
    expect(presenters.presenters).not.toContainEqual(PROCESS_VIEW_PRESENTER);
  } finally { remove(); }
});

it('rejects malformed process data before opening the UI', async () => {
  const ui = { custom: vi.fn(), notify: vi.fn() } as unknown as InteractionPresenterUi;
  const presenters = new ClientInteractionPresenters(ui); const remove = registerProcessesPresenter(presenters, ui);
  try {
    await expect(presenters.present(interaction({ ...state, selectedId: 'outside' }), new AbortController().signal)).rejects.toThrow('Invalid process view data');
    expect(ui.custom).not.toHaveBeenCalled();
  } finally { remove(); }
});
