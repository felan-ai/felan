import { expect, it, vi } from 'vitest';
import type { ContextReport } from '@felan-ai/ext-context-view';
import { CONTEXT_VIEW_PRESENTER, createContextViewRequest } from '@felan-ai/ext-context-view/view';
import type { Interaction, JsonValue } from '@felan-ai/session-protocol';
import { ClientInteractionPresenters, type InteractionPresenterUi } from '../src/client/presenters.js';
import { registerContextViewPresenter } from '../src/client/context-view-presenter.js';

const report: ContextReport = { breakdown: { systemPrompt: 0, systemTools: 0, extensions: 0, contextFiles: 0, skills: 0, memory: 0, messages: 0, other: 0, available: 0 },
  usedTokens: 0, contextWindow: null, usagePercent: null, estimated: true, systemToolCount: 0, extensionToolCount: 0, contextFileCount: 0, skillCount: 0,
  memory: { summary: 0, index: 0, schema: 0, recalls: 0 }, extensionDetails: [], skillDetails: [], modelLabel: 'Unknown window' };
function interaction(): Interaction {
  return { id: 'context', state: 'waiting', createdAt: Date.now(), eligibleClientKinds: ['tui'], scope: { kind: 'session', session: 'session', root: 'session' },
    request: { kind: 'custom', presenter: CONTEXT_VIEW_PRESENTER, data: createContextViewRequest(report, 'overlay') as unknown as JsonValue } };
}

it('renders the existing overlay, answers close, and aborts active UI on unregister', async () => {
  let panel: { handleInput(key: string): void; render(width: number): string[] } | undefined;
  const custom = vi.fn((factory: (...args: unknown[]) => unknown, _options?: unknown) => new Promise(resolve => {
    panel = factory({ requestRender() {} }, { fg: (_key: string, text: string) => text, bold: (text: string) => text }, {}, resolve) as typeof panel;
  }));
  const ui = { custom, notify: vi.fn() } as unknown as InteractionPresenterUi;
  const presenters = new ClientInteractionPresenters(ui); const remove = registerContextViewPresenter(presenters, ui);
  try {
    const first = presenters.present(interaction(), new AbortController().signal);
    await vi.waitFor(() => expect(panel).toBeDefined());
    expect(custom.mock.calls[0]?.[1]).toMatchObject({ overlay: true }); expect(panel!.render(88).join('\n')).toContain('Unknown window');
    panel!.handleInput('q'); expect(await first).toMatchObject({ state: 'answered', answer: { data: { closed: true } } });
    panel = undefined; const second = presenters.present(interaction(), new AbortController().signal);
    await vi.waitFor(() => expect(panel).toBeDefined()); remove(); expect(await second).toMatchObject({ state: 'cancelled' });
  } finally { remove(); }
});
