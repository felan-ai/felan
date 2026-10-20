import { afterEach, expect, it, vi } from 'vitest';
import type { Interaction, JsonValue } from '@felan-ai/session-protocol';
import type { TuiSessionController } from '../src/tui/controller.js';
import type { InteractionPresenterUi } from '../src/client/presenters.js';
import { createTerminalPresenters } from '../src/tui/presenters.js';
import { TERMINAL_INTERACTION_KINDS } from '../src/tui/interactions.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function fixture(available = true) {
  const controller = { client: { capabilities: { operations: available ? ['host.open_interaction'] : [] } },
    perform: vi.fn(async (_operation: string, _params: unknown) => ({ outcome: 'accepted' })), subscribe: () => () => {}, sessionId: undefined };
  const confirm = vi.fn<InteractionPresenterUi['confirm']>(async () => true);
  const select = vi.fn<InteractionPresenterUi['select']>(async () => undefined);
  const ui = { confirm, select, notify: vi.fn(), onTerminalInput: () => () => {} } as unknown as InteractionPresenterUi;
  const terminal = createTerminalPresenters(controller as unknown as TuiSessionController, ui, { setEditorText() {},
    settings: () => ({ hideThinking: false, showImages: false, imageWidthCells: 60, outputPad: 1, toolMode: 'grouped' }), toolPresentation: () => undefined });
  cleanups.push(() => terminal.dispose());
  return { controller, confirm, select, terminal };
}

it('does not advertise removed special-purpose interaction kinds', () => {
  const f = fixture();
  expect(TERMINAL_INTERACTION_KINDS).not.toContain('oauth');
  expect(TERMINAL_INTERACTION_KINDS).not.toContain('trust');
  expect(f.controller.perform).not.toHaveBeenCalled();
});
