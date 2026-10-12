import { afterEach, expect, it, vi } from 'vitest';
import { BROWSER_SETUP_PRESENTER } from '@felan-ai/ext-browser/presentation';
import { INSIGHTS_REPORT_PRESENTER } from '@felan-ai/ext-insights/view';
import type { Interaction, JsonValue } from '@felan-ai/session-protocol';
import type { TuiSessionController } from '../src/tui/controller.js';
import type { InteractionPresenterUi } from '../src/client/presenters.js';
import { createTerminalPresenters, TERMINAL_PRESENTERS } from '../src/tui/presenters.js';
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

function custom(presenter: { id: string; version: string }, data: JsonValue): Interaction {
  return { id: 'opening', scope: { kind: 'host' }, state: 'waiting', createdAt: 1, eligibleClientKinds: ['tui'], request: { kind: 'custom', presenter, data } };
}
function oauth(): Interaction {
  return { id: 'oauth', scope: { kind: 'host' }, state: 'waiting', createdAt: 1, eligibleClientKinds: ['tui'],
    request: { kind: 'oauth', provider: 'provider', url: 'https://example.test/authorize', instructions: 'Complete authorization', provisioningId: 'provision' } };
}

it('advertises the exact browser and insights presenter IDs and OAuth kind', () => {
  const f = fixture();
  expect(TERMINAL_PRESENTERS).toContainEqual({ id: 'felan.browser.setup', version: '1' });
  expect(TERMINAL_PRESENTERS).toContainEqual({ id: 'felan.insights-report', version: '1' });
  expect(f.terminal.presenters.presenters).toContainEqual(BROWSER_SETUP_PRESENTER);
  expect(f.terminal.presenters.presenters).toContainEqual(INSIGHTS_REPORT_PRESENTER);
  expect(TERMINAL_INTERACTION_KINDS).toContain('oauth'); expect(f.terminal.presenters.interactionKinds).toContain('oauth');
});

it.each([
  [BROWSER_SETUP_PRESENTER, { applicationPath: '/Applications/Google Chrome.app' }],
  [INSIGHTS_REPORT_PRESENTER, { path: '/fixture/insights-reports/felan-insights.html' }],
] as const)('confirms %j and opens only through the host-scoped operation', async (presenter, data) => {
  const f = fixture(); const result = await f.terminal.presenters.present(custom(presenter, data), new AbortController().signal);
  expect(result).toMatchObject({ state: 'answered', answer: { kind: 'custom', data: { opened: true } } });
  expect(f.confirm).toHaveBeenCalledOnce();
  expect(f.controller.perform.mock.calls).toEqual([['host.open_interaction', { interactionId: 'opening', confirmed: true }]]);
});

it('returns opened false on explicit decline without opening anything', async () => {
  const f = fixture(); f.confirm.mockResolvedValue(false);
  expect(await f.terminal.presenters.present(custom(BROWSER_SETUP_PRESENTER, { applicationPath: '/Applications/Chrome.app' }), new AbortController().signal))
    .toMatchObject({ state: 'answered', answer: { data: { opened: false } } });
  expect(f.controller.perform).not.toHaveBeenCalled();
});

it('validates data and reports missing opening support rather than pretending success', async () => {
  const f = fixture();
  await expect(f.terminal.presenters.present(custom(BROWSER_SETUP_PRESENTER, { applicationPath: '' }), new AbortController().signal)).rejects.toThrow();
  await expect(f.terminal.presenters.present(custom(INSIGHTS_REPORT_PRESENTER, { path: '/etc/passwd' }), new AbortController().signal)).rejects.toThrow('Invalid insights');
  expect(f.confirm).not.toHaveBeenCalled(); expect(f.controller.perform).not.toHaveBeenCalled();
  const missing = fixture(false);
  await expect(missing.terminal.presenters.present(oauth(), new AbortController().signal)).rejects.toThrow('host.open_interaction');
  expect(missing.controller.perform).not.toHaveBeenCalled();
});

it('does not report successful opening for a rejected host response', async () => {
  const f = fixture(); f.controller.perform.mockResolvedValueOnce({ outcome: 'rejected' });
  await expect(f.terminal.presenters.present(custom(BROWSER_SETUP_PRESENTER, { applicationPath: '/Applications/Chrome.app' }), new AbortController().signal))
    .rejects.toThrow('could not confirm');
});

it('confirms OAuth URLs and submits no credentials through the interaction result', async () => {
  const f = fixture(); const result = await f.terminal.presenters.present(oauth(), new AbortController().signal);
  expect(f.confirm).toHaveBeenCalledWith(expect.stringContaining('OAuth'), 'https://example.test/authorize', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(f.controller.perform.mock.calls).toEqual([['host.open_interaction', { interactionId: 'oauth', confirmed: true }]]);
  expect(result).toEqual({ state: 'cancelled', reason: 'user' });
  expect(f.select).toHaveBeenCalledWith('Complete authorization', ['Cancel authorization'], expect.anything());
});

it('treats OAuth decline as user cancellation without opening or another dialog', async () => {
  const f = fixture(); f.confirm.mockResolvedValueOnce(false);
  expect(await f.terminal.presenters.present(oauth(), new AbortController().signal)).toEqual({ state: 'cancelled', reason: 'user' });
  expect(f.controller.perform).not.toHaveBeenCalled(); expect(f.select).not.toHaveBeenCalled();
});

it('aborts opening confirmation on presenter disposal', async () => {
  const f = fixture();
  f.confirm.mockImplementation((_title, _message, options) => new Promise(resolve => options?.signal?.addEventListener('abort', () => resolve(false), { once: true })));
  const result = f.terminal.presenters.present(custom(BROWSER_SETUP_PRESENTER, { applicationPath: '/Applications/Chrome.app' }), new AbortController().signal);
  await f.terminal.dispose(); await result; expect(f.controller.perform).not.toHaveBeenCalled();
});
