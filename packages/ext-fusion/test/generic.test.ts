import {
  MODELS_SERVICE, createExtensionServiceAccess, createFelanServiceRegistry, createUnavailableExtensionUi,
  type AssistantMessage, type ExtensionCommandContext, type ExtensionUi, type FelanExtensionAPI, type ModelsService,
  type SessionEntry, type TextModelInfo, type UiInteractiveElement, type UiPresentOptions, type UiRequestResult,
} from '@felan-ai/agent-core';
import { parseUiForm, parseUiPresentation, validateUiFormAnswer, type UiForm, type UiValues } from '@felan-ai/session-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import extension, { DEFAULT_FUSION_CONFIG, FUSION_STATE_ENTRY } from '../src/index.js';
import { FUSION_PICKER_HINT, FUSION_REVIEW_HINT } from '../src/generic-ui.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
const info = (id: string): TextModelInfo => ({ provider: 'fixture', id, name: `Model ${id}`, api: 'openai-completions',
  input: ['text'], reasoning: false, contextWindow: 8192, maxTokens: 2048,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
const response = (id: string, text = `Answer from ${id}`): AssistantMessage => ({ role: 'assistant', provider: 'fixture', model: id,
  api: 'openai-completions', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.now(),
  usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } } });

function fixture(options: { models?: boolean; catalogue?: TextModelInfo[]; participants?: string[]; maxOutputChars?: number } = {}) {
  const catalogue = options.catalogue ?? [info('one'), info('two'), info('judge')];
  const models = {
    getAvailable: vi.fn<ModelsService['getAvailable']>().mockResolvedValue(catalogue),
    completeSimple: vi.fn<ModelsService['completeSimple']>(async model => response(model.id)),
    streamSimple: vi.fn<ModelsService['streamSimple']>(() => { throw new Error('Unexpected streaming call.'); }),
    getAvailableOfType: vi.fn<ModelsService['getAvailableOfType']>().mockResolvedValue([]),
    generateImages: vi.fn<ModelsService['generateImages']>(async () => { throw new Error('Unexpected image request.'); }),
  } satisfies ModelsService;
  const registry = createFelanServiceRegistry();
  if (options.models !== false) registry.set(MODELS_SERVICE, models);
  const forms: Array<{ form: UiForm; pending: boolean; reply(value: UiRequestResult): void }> = [];
  const views: Array<{ value: UiInteractiveElement; options: UiPresentOptions; closed: boolean; close: ReturnType<typeof vi.fn> }> = [];
  const entries: SessionEntry[] = [];
  const commands = new Map<string, (args: string, context: ExtensionCommandContext) => Promise<void>>();
  const events = new Map<string, Array<() => Promise<void>>>();
  const ui: ExtensionUi = {
    ...createUnavailableExtensionUi(), notify: vi.fn(async () => {}),
    request: async (form, options) => {
      const answer = deferred<UiRequestResult>();
      const row = { form: parseUiForm(form), pending: true, reply(value: UiRequestResult) { row.pending = false; answer.resolve(value); } };
      forms.push(row);
      const abort = () => row.reply({ state: 'cancelled', reason: 'abort' });
      options?.signal?.addEventListener('abort', abort, { once: true });
      if (options?.signal?.aborted) abort();
      try { return await answer.promise; } finally { options?.signal?.removeEventListener('abort', abort); }
    },
    present: async (value, options = {}) => {
      parseUiPresentation(value);
      const row = { value: structuredClone(value), options, closed: false, close: vi.fn(async () => { row.closed = true; }) };
      views.push(row);
      return { close: row.close, update: async next => {
        expect(row.closed).toBe(false); expect(next.id).toBe(row.value.id); expect(next.revision).toBeGreaterThan(row.value.revision);
        parseUiPresentation(next); row.value = structuredClone(next);
      } };
    },
  };
  const pi = {
    config: { ...DEFAULT_FUSION_CONFIG, participants: options.participants ?? ['fixture/one', 'fixture/two'], fusionModel: 'fixture/judge',
      maxOutputChars: options.maxOutputChars ?? DEFAULT_FUSION_CONFIG.maxOutputChars },
    ui, services: createExtensionServiceAccess(registry, extension.serviceRequirements!),
    registerCommand: (name: string, value: { handler: (args: string, context: ExtensionCommandContext) => Promise<void> }) => commands.set(name, value.handler),
    on: (name: string, handler: () => Promise<void>) => events.set(name, [...(events.get(name) ?? []), handler]),
    appendEntry: vi.fn((customType: string, data: unknown) => entries.push({ type: 'custom', id: `entry-${entries.length}`, parentId: null,
      timestamp: new Date().toISOString(), customType, data })),
    sendMessage: vi.fn(),
    updateConfig: vi.fn<FelanExtensionAPI['updateConfig']>(async () => {}),
  } as unknown as FelanExtensionAPI;
  const context = { hasUI: false, mode: 'print', isIdle: () => true, signal: new AbortController().signal,
    model: { provider: 'fixture', id: 'judge' }, sessionManager: { getBranch: () => entries },
    get modelRegistry(): never { throw new Error('Legacy model registry must not be read.'); },
    get ui(): never { throw new Error('Legacy UI must not be read.'); },
  } as unknown as ExtensionCommandContext;
  extension(pi);
  const shutdown = async () => { for (const handler of events.get('session_shutdown') ?? []) await handler(); };
  cleanups.push(shutdown);
  const answer = (actionId: string, values: UiValues = {}) => {
    const row = [...forms].reverse().find(form => form.pending)!;
    row.reply({ state: 'answered', answer: validateUiFormAnswer(row.form, {
      kind: 'form', actionId, outcome: row.form.actions.find(action => action.id === actionId)!.outcome, values,
    }) });
  };
  const current = (kind: UiInteractiveElement['kind']) => {
    const row = [...views].reverse().find(row => !row.closed && row.value.kind === kind);
    if (!row) throw new Error(`No open ${kind}.`); return row;
  };
  const act = async (row: typeof views[number], actionId: string, values: UiValues = {}, itemId?: string) => {
    const source = row.value;
    return row.options.onAction!({ elementId: source.id, revision: source.revision, actionId,
      outcome: source.actions.find(action => action.id === actionId)?.outcome ?? 'submit', values,
      ...(itemId === undefined ? {} : { itemId }) }, { requestId: `action-${source.revision}`, signal: context.signal! });
  };
  return { pi, context, models, registry, forms, views, entries, ui, commands, answer, current, act, shutdown,
    start: (prompt = 'Solve the explicit question') => commands.get('fusion')!(prompt, context),
    modelsCommand: () => commands.get('fusion-models')!('', context),
  };
}

async function compare(h: ReturnType<typeof fixture>) {
  const command = h.start();
  await vi.waitFor(() => expect(h.forms.some(form => form.pending)).toBe(true));
  h.answer('compare');
  await vi.waitFor(() => expect(h.views.some(row => !row.closed && row.value.kind === 'document')).toBe(true));
  return { command, view: h.current('document') };
}

describe('Fusion generic default', () => {
  it('requires only optional Models and never consumes a legacy Fusion host', async () => {
    const h = fixture({ models: false });
    expect(extension.serviceRequirements).toEqual({ optional: [MODELS_SERVICE] });
    await h.start(); await h.modelsCommand();
    expect(h.ui.notify).toHaveBeenCalledWith({ level: 'warning', text: 'Fusion requires a configured Models service.' });
    expect(h.models.completeSimple).not.toHaveBeenCalled(); expect(h.forms).toHaveLength(0);
  });

  it('does not treat unavailable standalone UI as approval to call models', async () => {
    const h = fixture(); Object.assign(h.pi, { ui: createUnavailableExtensionUi() });
    await h.start();
    expect(h.models.completeSimple).not.toHaveBeenCalled();
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it('does not infer approval from deferred form delivery', async () => {
    const h = fixture(); const command = h.start();
    await vi.waitFor(() => expect(h.forms.some(form => form.pending)).toBe(true));
    h.forms.at(-1)!.reply({ state: 'deferred', interactionId: 'pending-comparison' }); await command;
    expect(h.models.completeSimple).not.toHaveBeenCalled();
    expect(h.ui.notify).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('pending-comparison') }));
  });

  it('compares through the portable Models API without automatically synthesizing or applying output', async () => {
    const h = fixture(); const { command, view } = await compare(h);
    expect(h.models.completeSimple).toHaveBeenCalledTimes(3);
    for (const [model, context, options] of h.models.completeSimple.mock.calls) {
      expect(model).toEqual({ provider: 'fixture', id: expect.any(String) });
      expect(context).not.toHaveProperty('tools'); expect(context.messages).toHaveLength(1);
      expect(options).toMatchObject({ signal: expect.any(AbortSignal), maxTokens: 2048 });
    }
    expect(view.value).toMatchObject({ kind: 'document', hint: FUSION_REVIEW_HINT, markdown: expect.stringContaining('reported estimated cost: 0\\.003 USD') });
    expect(view.value.actions.some(action => action.id === 'synthesize')).toBe(true);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    expect(h.entries.some(entry => entry.type === 'custom' && entry.customType === FUSION_STATE_ENTRY)).toBe(true);
    await h.act(view, 'close'); await command;
    const reopen = h.start('');
    await vi.waitFor(() => expect(h.views.some(row => !row.closed && row.value.kind === 'document')).toBe(true));
    expect(h.models.completeSimple).toHaveBeenCalledTimes(3);
    await h.act(h.current('document'), 'close'); await reopen;
  });

  it('requires comparison, retries it explicitly, then synthesizes only on the declared action', async () => {
    const h = fixture();
    h.models.completeSimple.mockImplementation(async model => { if (model.id === 'judge') throw new Error('Comparison unavailable'); return response(model.id); });
    const { command, view } = await compare(h);
    expect(view.value.actions.some(action => action.id === 'synthesize')).toBe(false);
    await expect(h.act(view, 'synthesize')).rejects.toThrow();
    h.models.completeSimple.mockImplementation(async model => response(model.id));
    await h.act(view, 'retry-comparison');
    expect(h.models.completeSimple).toHaveBeenCalledTimes(4);
    await h.act(view, 'synthesize', { instruction: 'Keep all verified constraints.', model: 'fixture/one' });
    expect(h.models.completeSimple).toHaveBeenCalledTimes(5);
    const [selected, request] = h.models.completeSimple.mock.calls.at(-1)!;
    expect(selected).toEqual({ provider: 'fixture', id: 'one' });
    expect(JSON.stringify(request)).toContain('Keep all verified constraints.');
    expect(h.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ content: 'Answer from one', display: true }), { triggerTurn: false });
    await h.act(view, 'close'); await command;
  });

  it('retries only failed participants and retains synthesis instructions on retry', async () => {
    const h = fixture(); let fail = true;
    h.models.completeSimple.mockImplementation(async model => { if (fail && model.id === 'one') throw new Error('Provider unavailable'); return response(model.id); });
    const { command, view } = await compare(h);
    expect(h.models.completeSimple).toHaveBeenCalledTimes(2); fail = false;
    await h.act(view, 'retry-participants');
    expect(h.models.completeSimple.mock.calls.map(([model]) => model.id)).toEqual(['one', 'two', 'one', 'judge']);
    h.models.completeSimple.mockRejectedValueOnce(new Error('Synthesis unavailable'));
    await h.act(view, 'synthesize', { instruction: 'Use the same instruction.', model: 'fixture/two' });
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    await h.act(view, 'retry-synthesis');
    const [model, request] = h.models.completeSimple.mock.calls.at(-1)!;
    expect(model).toEqual({ provider: 'fixture', id: 'two' }); expect(JSON.stringify(request)).toContain('Use the same instruction.');
    expect(h.pi.sendMessage).toHaveBeenCalledOnce();
    await h.act(view, 'close'); await command;
  });

  it('aborts before joining every outstanding provider call and never compares late cancelled results', async () => {
    const h = fixture(); const finish = [deferred<AssistantMessage>(), deferred<AssistantMessage>()];
    h.models.completeSimple.mockImplementation((_model, _ctx, _options) => finish[h.models.completeSimple.mock.calls.length - 1]!.promise);
    let completed = false;
    const command = h.start().then(() => { completed = true; });
    await vi.waitFor(() => expect(h.forms.some(form => form.pending)).toBe(true)); h.answer('compare');
    await vi.waitFor(() => expect(h.models.completeSimple).toHaveBeenCalledTimes(2));
    await h.act(h.current('progress'), 'cancel');
    expect(h.models.completeSimple.mock.calls.every(([, , options]) => options!.signal!.aborted)).toBe(true);
    expect(completed).toBe(false);
    finish[0]!.resolve(response('one')); await Promise.resolve(); expect(completed).toBe(false);
    finish[1]!.resolve(response('two')); await command;
    expect(h.models.completeSimple).toHaveBeenCalledTimes(2); expect(h.pi.appendEntry).not.toHaveBeenCalled();
    expect(h.pi.sendMessage).not.toHaveBeenCalled(); expect(h.views.every(row => row.closed)).toBe(true);
  });

  it('propagates action cancellation into inference and restores review controls after the provider settles', async () => {
    const h = fixture(); const { command, view } = await compare(h);
    const finish = deferred<AssistantMessage>(); h.models.completeSimple.mockImplementationOnce(() => finish.promise);
    const control = new AbortController();
    const dispatch = view.options.onAction!({ elementId: view.value.id, revision: view.value.revision,
      actionId: 'synthesize', outcome: 'submit', values: {} }, { requestId: 'cancelled-action', signal: control.signal });
    const outcome = dispatch.catch(error => error);
    await vi.waitFor(() => expect(h.models.completeSimple).toHaveBeenCalledTimes(4));
    control.abort();
    expect(h.models.completeSimple.mock.calls[3]![2]!.signal!.aborted).toBe(true);
    finish.resolve(response('judge'));
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    expect(view.value.actions.some(action => action.id === 'synthesize')).toBe(true);
    await h.act(view, 'close'); await command;
  });

  it('allows the separate progress element to cancel a synthesis while its review action is pending', async () => {
    const h = fixture(); const { command, view } = await compare(h);
    const finish = deferred<AssistantMessage>(); h.models.completeSimple.mockImplementationOnce(() => finish.promise);
    const synthesis = h.act(view, 'synthesize');
    await vi.waitFor(() => expect(h.models.completeSimple).toHaveBeenCalledTimes(4));
    await h.act(h.current('progress'), 'cancel');
    expect(h.models.completeSimple.mock.calls[3]![2]!.signal!.aborted).toBe(true);
    finish.resolve(response('judge')); await synthesis;
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    expect(view.value.actions.some(action => action.id === 'retry-synthesis')).toBe(true);
    await h.act(view, 'close'); await command;
  });

  it('saves a paginated searchable lineup in the session without inference and restores it on the next command', async () => {
    const h = fixture({ catalogue: Array.from({ length: 85 }, (_, index) => info(`model-${index}`)), participants: [] });
    const selecting = h.modelsCommand();
    await vi.waitFor(() => expect(h.views.some(row => row.value.kind === 'view')).toBe(true));
    const view = h.current('view');
    expect(view.value.hint).toEqual(FUSION_PICKER_HINT);
    await h.act(view, 'participant', {}, 'model-0'); await h.act(view, 'participant', {}, 'model-1');
    await h.act(view, 'next'); await h.act(view, 'next');
    expect(view.value).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: 'model-84' })]) });
    await h.act(view, 'comparison', {}, 'model-84');
    await h.act(view, 'search', { query: 'model-0' });
    const stale = { ...view.value };
    await h.act(view, 'search', { query: 'model-1' });
    await expect(view.options.onAction!({ elementId: stale.id, revision: stale.revision, actionId: 'save', outcome: 'submit', values: {} },
      { requestId: 'stale', signal: h.context.signal! })).rejects.toThrow();
    await h.act(view, 'save'); await selecting;
    expect(h.models.completeSimple).not.toHaveBeenCalled();
    expect(h.pi.appendEntry).toHaveBeenCalledWith('felan.fusion-lineup.v1', { participants: ['fixture/model-0', 'fixture/model-1'], fusionModel: 'fixture/model-84' });
    expect(h.pi.updateConfig).toHaveBeenCalledWith({ participants: ['fixture/model-0', 'fixture/model-1'], fusionModel: 'fixture/model-84' });
    await h.shutdown(); extension(h.pi);
    const command = h.start();
    await vi.waitFor(() => expect(h.forms.some(form => form.pending)).toBe(true));
    expect(h.forms.at(-1)!.form.markdown).toContain('fixture/model'); h.answer('cancel'); await command;
    expect(h.models.completeSimple).not.toHaveBeenCalled();
  });

  it('awaits global lineup persistence before closing the model picker', async () => {
    const h = fixture(); const persisted = deferred<void>();
    vi.mocked(h.pi.updateConfig).mockImplementationOnce(() => persisted.promise);
    let done = false;
    const command = h.modelsCommand().then(() => { done = true; });
    await vi.waitFor(() => expect(h.views.some(row => row.value.kind === 'view')).toBe(true));
    const view = h.current('view'); const save = h.act(view, 'save');
    await vi.waitFor(() => expect(h.pi.updateConfig).toHaveBeenCalledOnce());
    expect(done).toBe(false); expect(view.closed).toBe(false);
    expect(h.pi.appendEntry).toHaveBeenCalledWith('felan.fusion-lineup.v1', { participants: ['fixture/one', 'fixture/two'], fusionModel: 'fixture/judge' });
    persisted.resolve(); await save; await command;
    expect(view.closed).toBe(true); expect(h.models.completeSimple).not.toHaveBeenCalled();
  });

  it.each(['configuration persistence is unsupported', 'host policy denied the write'])(
    'retains branch state and reports global persistence failure: %s', async message => {
      const h = fixture(); vi.mocked(h.pi.updateConfig).mockRejectedValueOnce(new Error(message));
      const command = h.modelsCommand();
      await vi.waitFor(() => expect(h.views.some(row => row.value.kind === 'view')).toBe(true));
      const view = h.current('view');
      await expect(h.act(view, 'save')).rejects.toThrow('global settings persistence failed');
      expect(h.ui.notify).toHaveBeenCalledWith({ level: 'error', text: expect.stringContaining(message) });
      expect(h.pi.appendEntry).toHaveBeenCalledWith('felan.fusion-lineup.v1', expect.objectContaining({ participants: ['fixture/one', 'fixture/two'] }));
      expect(view.closed).toBe(false); expect(h.models.completeSimple).not.toHaveBeenCalled();
      await h.act(view, 'cancel'); await command;
    },
  );

  it('joins shutdown while inference ignores cancellation and fences late review publication', async () => {
    const h = fixture(); const finish = deferred<AssistantMessage>(); h.models.completeSimple.mockImplementation(() => finish.promise);
    const command = h.start(); await vi.waitFor(() => expect(h.forms.some(form => form.pending)).toBe(true)); h.answer('compare');
    await vi.waitFor(() => expect(h.models.completeSimple).toHaveBeenCalledTimes(2));
    let stopped = false; const shutdown = h.shutdown().then(() => { stopped = true; });
    expect(stopped).toBe(false); expect(h.models.completeSimple.mock.calls[0]![2]!.signal!.aborted).toBe(true);
    finish.resolve(response('one')); await shutdown; await command;
    expect(h.views.every(row => row.closed)).toBe(true); expect(h.pi.appendEntry).not.toHaveBeenCalled();
    await expect(h.start()).rejects.toThrow('shutting down');
  });

  it('closes a late-created progress handle exactly once during shutdown', async () => {
    const h = fixture(); const entered = deferred<void>(); const release = deferred<void>();
    const present = h.ui.present;
    h.ui.present = async (...args) => { entered.resolve(); await release.promise; return present(...args); };
    const command = h.start(); await vi.waitFor(() => expect(h.forms.some(form => form.pending)).toBe(true)); h.answer('compare');
    await entered.promise;
    let stopped = false; const shutdown = h.shutdown().then(() => { stopped = true; });
    expect(stopped).toBe(false); release.resolve(); await shutdown; await command;
    expect(h.views).toHaveLength(1); expect(h.views[0]!.close).toHaveBeenCalledOnce();
    expect(h.models.completeSimple).not.toHaveBeenCalled();
  });

  it('rechecks current Models availability before dispatch rather than trusting saved model metadata', async () => {
    const h = fixture(); let calls = 0;
    h.models.getAvailable.mockImplementation(async () => ++calls > 2 ? [info('two'), info('judge')] : [info('one'), info('two'), info('judge')]);
    const { command, view } = await compare(h);
    expect(h.models.completeSimple.mock.calls.map(([model]) => model.id)).toEqual(['two']);
    expect(view.value.actions.some(action => action.id === 'synthesize')).toBe(false);
    await h.act(view, 'close'); await command;
  });

  it('paginates full review text and renders model output as escaped untrusted content', async () => {
    const h = fixture({ maxOutputChars: 50_000 });
    h.models.completeSimple.mockImplementation(async model => response(model.id, `<script>[link](file:///private)\u001b[31m${'界'.repeat(12_000)}`));
    const { command, view } = await compare(h);
    let text = ''; let pages = 0;
    for (;;) {
      if (view.value.kind !== 'document') throw new Error('Expected review document.');
      text += view.value.markdown; pages++;
      expect(new TextEncoder().encode(view.value.markdown).length).toBeLessThanOrEqual(24_000);
      if (!view.value.actions.some(action => action.id === 'next')) break;
      await h.act(view, 'next');
    }
    expect(pages).toBeGreaterThan(1); expect(text.match(/界/gu)).toHaveLength(36_000);
    expect(text).not.toContain('<script>'); expect(text).not.toContain('\u001b');
    expect(h.models.completeSimple).toHaveBeenCalledTimes(3);
    await h.act(view, 'close'); await command;
  });

  it('keeps unknown provider cost unknown and rejects undeclared or malformed actions', async () => {
    const h = fixture();
    h.models.completeSimple.mockImplementation(async model => ({ ...response(model.id), usage: undefined }) as unknown as AssistantMessage);
    const { command, view } = await compare(h);
    expect(view.value).toMatchObject({ markdown: expect.stringContaining('usage/cost unavailable') });
    expect(view.value).toMatchObject({ markdown: expect.not.stringContaining('estimated cost: 0') });
    await expect(h.act(view, 'synthesize', { model: 'fixture/not-available' })).resolves.toBeUndefined();
    expect(h.models.completeSimple).toHaveBeenCalledTimes(3);
    await expect(h.act(view, 'synthesize', { extra: 'not declared' })).rejects.toThrow();
    await expect(view.options.onAction!({ elementId: 'foreign', revision: view.value.revision, actionId: 'close', outcome: 'cancel', values: {} },
      { requestId: 'foreign', signal: h.context.signal! })).rejects.toThrow();
    await h.act(view, 'close'); await command;
    await expect(h.act(view, 'close')).rejects.toThrow();
  });
});
