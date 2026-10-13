import { describe, expect, it, vi } from 'vitest';
import { parseInteraction, type UiDocument, type UiForm } from '@felan-ai/session-protocol';
import { UiHintRenderers } from '../src/client/hint-renderers.js';
import { presentUiElement, presentUiForm, type GenericUiDriver } from '../src/client/ui.js';
import { ClientInteractionPresenters, type InteractionPresenterUi } from '../src/client/presenters.js';

const hint = { id: 'test.form', version: '1' };
const form: UiForm = { hint, title: 'Question', fallback: 'Answer or cancel',
  input: { fields: [{ id: 'text', label: 'Answer', kind: 'string', required: true, maxLength: 20 }] },
  actions: [{ id: 'send', label: 'Send', outcome: 'submit', target: 'element' }] };
const answer = { kind: 'form' as const, actionId: 'send', outcome: 'submit' as const, values: { text: 'Answer' } };
const document: UiDocument = { hint, id: 'document', kind: 'document', revision: 2, title: 'Report', markdown: 'Full report', fallback: 'Report',
  actions: [{ id: 'close', label: 'Close', outcome: 'cancel', target: 'element' }] };
const action = { elementId: 'document', revision: 2, actionId: 'close', outcome: 'cancel' as const, values: {} };
const signal = () => new AbortController().signal;
function driver(): GenericUiDriver {
  return { choose: vi.fn(async () => 'send'), fields: vi.fn(async () => ({ text: 'Generic' })), display: vi.fn(async () => {}) };
}

describe('client-only hint renderers', () => {
  it('dispatches by exact hint identity and version; missing hints, versions and element handlers use generic rendering', async () => {
    const hints = new UiHintRenderers(); const ui = driver(); const render = vi.fn(async () => answer);
    const unregister = hints.register(hint, { form: render });
    expect(() => hints.register(hint, {})).toThrow('already registered');
    expect(await presentUiForm(form, ui, signal(), hints)).toEqual(answer);
    expect(ui.choose).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledWith(form, expect.any(AbortSignal));
    const { hint: _hint, ...plain } = form;
    for (const source of [plain, { ...form, hint: { ...hint, version: '2' } }]) {
      expect(await presentUiForm(source, ui, signal(), hints)).toMatchObject({ values: { text: 'Generic' } });
    }
    vi.mocked(ui.choose).mockResolvedValue('0'); vi.mocked(ui.fields).mockResolvedValue({});
    expect(await presentUiElement(document, ui, signal(), true, hints)).toEqual(action);
    unregister(); unregister();
    expect(hints.get(hint)).toBeUndefined();
    expect(render).toHaveBeenCalledOnce();
  });

  it('does not turn renderer dismissal or abort into a second generic prompt', async () => {
    const hints = new UiHintRenderers(); const ui = driver();
    const render = vi.fn(async () => undefined);
    hints.register(hint, { form: render });
    expect(await presentUiForm(form, ui, signal(), hints)).toBeUndefined();
    const aborted = new AbortController(); aborted.abort();
    expect(await presentUiForm(form, ui, aborted.signal, hints)).toBeUndefined();
    expect(render).toHaveBeenCalledOnce(); expect(ui.choose).not.toHaveBeenCalled();
  });

  it.each([
    { ...answer, actionId: 'undeclared' },
    { ...answer, outcome: 'cancel' as const },
    { ...answer, values: { secret: 'not a field' } },
    { ...answer, values: { text: 'x'.repeat(21) } },
  ])('validates hinted form answers against the original element: %j', async invalid => {
    const hints = new UiHintRenderers();
    hints.register(hint, { form: async source => {
      source.actions.push({ id: 'undeclared', label: 'Unsafe', outcome: 'submit', target: 'element' });
      return invalid;
    } });
    await expect(presentUiForm(form, driver(), signal(), hints)).rejects.toThrow();
    expect(form.actions).toHaveLength(1);
  });

  it('validates hinted presentation actions and respects negotiated read-only mode', async () => {
    const hints = new UiHintRenderers(); const ui = driver();
    const render = vi.fn(async () => action);
    hints.register(hint, { presentation: render });
    expect(await presentUiElement(document, ui, signal(), true, hints)).toEqual(action);
    expect(ui.choose).not.toHaveBeenCalled();
    expect(await presentUiElement(document, ui, signal(), false, hints)).toBeUndefined();
    expect(render).toHaveBeenCalledOnce(); expect(ui.display).toHaveBeenCalledOnce();
    for (const invalid of [{ ...action, actionId: 'undeclared' }, { ...action, revision: 1 }, { ...action, values: { extra: true } }]) {
      render.mockResolvedValueOnce(invalid);
      await expect(presentUiElement(document, ui, signal(), true, hints)).rejects.toThrow();
    }
  });

  it('routes form interactions through the registry without advertising hints as legacy presenters', async () => {
    const ui = { select: vi.fn(), notify: vi.fn() } as unknown as InteractionPresenterUi;
    const presenters = new ClientInteractionPresenters(ui);
    const before = presenters.interactionKinds;
    presenters.hints.register(hint, { form: async () => answer });
    const item = parseInteraction({ id: 'form', state: 'waiting', createdAt: Date.now(),
      scope: { kind: 'session', root: 'session', session: 'session' },
      request: { kind: 'form', form } });
    expect(await presenters.present(item, signal())).toEqual({ state: 'answered', answer });
    expect(presenters.interactionKinds).toEqual(before); expect(presenters).not.toHaveProperty('presenters'); expect(ui.select).not.toHaveBeenCalled();
  });
});
