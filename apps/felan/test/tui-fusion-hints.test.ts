import type { Theme } from '@felan-ai/agent-core';
import type { Component } from '@earendil-works/pi-tui';
import { validateUiAction, type UiAction, type UiDocument, type UiView } from '@felan-ai/session-protocol';
import { describe, expect, it, vi } from 'vitest';
import { FUSION_PICKER_HINT, FUSION_REVIEW_HINT } from '@felan-ai/ext-fusion';
import { presentFusionPickerView, presentFusionReviewDocument } from '../src/tui/renderers/fusion.js';

const theme = {
  fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text,
  bold: (text: string) => text, italic: (text: string) => text,
  underline: (text: string) => text, strikethrough: (text: string) => text,
} as unknown as Theme;
const action = (id: string, target: 'element' | 'item' = 'element', outcome: 'submit' | 'cancel' = 'submit'): UiAction => ({ id, label: id, target, outcome });
let identity = 0;
const view = (): UiView => ({
  id: `picker-${++identity}`, revision: 7, kind: 'view', hint: FUSION_PICKER_HINT, title: 'Fusion model lineup', fallback: 'Select participants and comparison model.',
  fields: [{ id: 'model', label: 'Model', valueKind: 'text' }, { id: 'participant', label: 'Participant', valueKind: 'boolean' },
    { id: 'comparison', label: 'Comparison', valueKind: 'boolean' }],
  items: [false, true].map((selected, index) => ({ id: `model-${index + 40}`, fallback: `fixture/${index}`,
    values: { model: `Model ${index}`, participant: selected, comparison: selected } })),
  query: { actionId: 'search', values: { query: 'Model' } }, paging: { previousActionId: 'previous', nextActionId: 'next' },
  actions: [{ ...action('search'), input: { fields: [{ id: 'query', label: 'Search', kind: 'string', required: true, maxLength: 4096 }] } },
    action('participant', 'item'), action('comparison', 'item'), action('previous'), action('next'), action('clear'), action('save'), action('cancel', 'element', 'cancel')],
});
const document = (): UiDocument => ({
  id: `review-${++identity}`, revision: 13, kind: 'document', hint: FUSION_REVIEW_HINT, title: 'Fusion review', markdown: '## Comparison\n\nReview evidence, not verification.',
  fallback: 'Synthesis requires explicit approval.', actions: [
    action('retry-participants'), action('retry-comparison'),
    { ...action('synthesize'), input: { fields: [
      { id: 'instruction', kind: 'string', label: 'Instruction', required: false, multiline: true, maxLength: 16_000 },
      { id: 'model', kind: 'string', label: 'Model override', required: false, maxLength: 300 },
    ] } }, action('retry-synthesis'), action('close', 'element', 'cancel'),
  ],
});
function open(element: UiView | UiDocument, signal = new AbortController().signal) {
  let panel!: Component;
  const custom = vi.fn((factory: (...args: any[]) => Component) => new Promise(resolve => {
    panel = factory({ requestRender: vi.fn(), terminal: { rows: 30 } }, theme, {}, resolve);
  }));
  const result = element.kind === 'view'
    ? presentFusionPickerView(element, { custom: custom as never }, signal)
    : presentFusionReviewDocument(element, { custom: custom as never }, signal);
  return { result, custom, panel, key: (key: string) => panel.handleInput!(key) };
}

describe('Fusion vocabulary hint renderers', () => {
  it('renders declared model fields and returns the exact item/revision without saving implicitly', async () => {
    const source = view(); const h = open(source);
    expect(h.panel.render(100).join('\n')).toContain('Participant: true');
    h.key('\x1b[B'); h.key('\r');
    const result = await h.result;
    expect(result).toEqual({ elementId: source.id, revision: 7, actionId: 'participant', outcome: 'submit', itemId: 'model-41', values: {} });
    expect(validateUiAction(source, result)).toEqual(result);
    h.key('\x13');
  });

  it.each([
    ['\t', 'comparison', 'model-40'], ['\x1b[C', 'next', undefined], ['\x1b[D', 'previous', undefined],
    ['\x13', 'save', undefined], ['\x0c', 'clear', undefined], ['\x1b', undefined, undefined],
  ])('maps picker key %j to declared action %s', async (key, id, itemId) => {
    const source = view(); const h = open(source); h.key(key);
    if (key === '\t') h.key('\r');
    const result = await h.result;
    if (!id) { expect(result).toBeUndefined(); return; }
    expect(result).toMatchObject({ actionId: id, ...(itemId ? { itemId } : { values: {} }) });
    expect(validateUiAction(source, result)).toEqual(result);
    if (!itemId) expect(result).not.toHaveProperty('itemId');
  });

  it('keeps the selected model and action across a toggle revision', async () => {
    const source = view();
    const first = open(source); first.key('\x1b[B'); first.key('\r');
    expect(await first.result).toMatchObject({ itemId: 'model-41', actionId: 'participant' });
    const updated = { ...source, revision: source.revision + 1, items: [...source.items].reverse() };
    const second = open(updated); second.key('\t'); second.key('\r');
    expect(await second.result).toMatchObject({ itemId: 'model-41', actionId: 'comparison', revision: updated.revision });
  });

  it('edits authoritative query defaults and submits only the query field', async () => {
    const source = view(); const h = open(source); h.key('/'); h.key(' name'); h.key('\r');
    expect(await h.result).toEqual({ elementId: source.id, revision: 7, actionId: 'search', outcome: 'submit', values: { query: 'Model name' } });
  });

  it('does not synthesize missing picker actions or select off-page items', async () => {
    const source = view(); source.actions = [action('cancel', 'element', 'cancel')]; delete source.paging; delete source.query;
    source.items = [];
    const h = open(source); let finished = false; void h.result.then(() => { finished = true; });
    for (const key of ['\x13', '\x0c', '/', '\x1b[C']) h.key(key);
    await Promise.resolve(); expect(finished).toBe(false);
    h.key('\x1b'); expect(await h.result).toBeUndefined();
  });

  it.each(['retry-participants', 'retry-comparison', 'retry-synthesis', 'close'])('maps review action %s without running inference', async id => {
    const source = document(); const h = open(source);
    for (let index = 0; index < source.actions.findIndex(action => action.id === id); index++) h.key('\x1b[B');
    h.key('\r'); const result = await h.result;
    expect(result).toEqual({ elementId: source.id, revision: 13, actionId: id, outcome: id === 'close' ? 'cancel' : 'submit', values: {} });
  });

  it('collects declared synthesis instruction and model, preserving UTF-8 validation failures for correction', async () => {
    const source = document();
    source.actions = [{ ...action('synthesize'), input: { fields: [
      { id: 'instruction', kind: 'string', label: 'Instruction', required: false, maxLength: 5 },
      { id: 'model', kind: 'string', label: 'Model', required: false, maxLength: 300 },
    ] } }, action('close', 'element', 'cancel')];
    const h = open(source); h.key('\r'); h.key('界界'); h.key('\r'); h.key('fixture/one'); h.key('\r');
    expect(h.panel.render(100).join('\n')).toContain('Invalid UI string value.');
    expect(h.panel.render(100).join('\n')).toContain('界界');
    h.key('\t'); h.key('\x7f'); h.key('\r'); h.key('\r');
    const result = await h.result;
    expect(result).toMatchObject({ actionId: 'synthesize', values: { instruction: '界', model: 'fixture/one' } });
    expect(validateUiAction(source, result)).toEqual(result);
  });

  it('omits empty optional synthesis fields and allows abandoning input without synthesis', async () => {
    const source = document(); source.actions = source.actions.slice(2);
    const h = open(source); h.key('\r'); h.key('Draft'); h.key('\x1b'); h.key('\r'); h.key('\r'); h.key('\r');
    expect(await h.result).toMatchObject({ actionId: 'synthesize', values: {} });
  });

  it('renders all document content via scrolling, including busy reviews with no actions', async () => {
    const source = document(); source.actions = []; source.markdown = Array.from({ length: 100 }, (_, index) => `Evidence ${index}\n`).join('\n');
    const h = open(source);
    expect(h.panel.render(80).join('\n')).toContain('Evidence 0'); h.key('\x1b[F');
    expect(h.panel.render(80).join('\n')).toContain('Evidence 99'); h.key('\r'); h.key('\x1b');
    expect(await h.result).toBeUndefined();
  });

  it('strips terminal control characters from raw titles, model labels, action labels, and fields', async () => {
    const source = view(); source.title = 'Title\x1b[31mred\x07\x85'; source.items[0]!.values.model = 'Model\x1b]52;c;secret\x07name\x9b';
    source.fields[0]!.label = 'Label\x07'; source.actions[0]!.label = 'Search\x9f';
    const h = open(source); const rendered = h.panel.render(120).join('\n');
    expect(rendered).toContain('Titlered'); expect(rendered).toContain('Modelname'); expect(rendered).not.toContain('secret');
    expect(rendered).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/u);
    h.key('\x1b'); await h.result;
  });

  it('aborts open inputs, removes the listener, and ignores subsequent terminal actions', async () => {
    const control = new AbortController(); const remove = vi.spyOn(control.signal, 'removeEventListener');
    const h = open(document(), control.signal); h.key('\x1b[B'); h.key('\x1b[B'); h.key('\r'); control.abort();
    expect(await h.result).toBeUndefined(); expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    h.key('\r');
  });

  it('skips already aborted UI and rejects the wrong presentation kind', async () => {
    const custom = vi.fn();
    await expect(presentFusionPickerView(view(), { custom }, AbortSignal.abort())).resolves.toBeUndefined();
    expect(custom).not.toHaveBeenCalled();
    expect(() => presentFusionPickerView(document(), { custom }, new AbortController().signal)).toThrow('requires a view');
    expect(() => presentFusionReviewDocument(view(), { custom }, new AbortController().signal)).toThrow('requires a document');
  });
});
