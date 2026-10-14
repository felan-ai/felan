import {
  MODELS_SERVICE, SESSIONS_HISTORY_SERVICE, type ModelsService, type SessionEntry, type SessionsHistory,
} from '@felan-ai/agent-core';
import { parseUiPresentation, validateUiAction } from '@felan-ai/session-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import askUser from '../../../packages/ext-ask-user/src/extension.js';
import tasks from '../../../packages/ext-tasks/src/extension.js';
import prewalk from '../../../packages/ext-prewalk/src/extension.js';
import contextView from '../../../packages/ext-context-view/src/extension.js';
import powerline from '../../../packages/ext-powerline/src/extension.js';
import promptHistory from '../../../packages/ext-prompt-history/src/extension.js';
import insights from '../../../packages/ext-insights/src/extension.js';
import { INSIGHTS_DOCUMENT_HINT } from '../../../packages/ext-insights/src/ui.js';
import fusion from '../../../packages/ext-fusion/src/index.js';
import modelTools from '../../../packages/ext-model-tools/src/extension.js';
import { createPrewalkUiHost } from '../../../packages/ext-prewalk/src/ui.js';
import { clientRoute, commitAction, commitForm, extensionFixture } from './generic-extension-ui-fixtures.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function fixture() {
  const result = extensionFixture();
  cleanups.push(async () => {
    for (const form of result.forms) form.reply({ state: 'cancelled', reason: 'abort' });
    await result.emit('session_shutdown');
  });
  return result;
}
function route(...args: Parameters<typeof clientRoute>) {
  const result = clientRoute(...args); cleanups.push(() => result.dispose()); return result;
}
const userEntry = (id: string, text: string): SessionEntry => ({ type: 'message', id, parentId: null,
  timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: text, timestamp: Date.parse('2026-01-01') } });
function historyFixture(text = 'Read the complete historical prompt without running it.') {
  const entries = [userEntry('entry', text)];
  return {
    current: { id: 'session', root: 'session' },
    list: vi.fn<SessionsHistory['list']>().mockResolvedValue({ items: [
      { id: 'archived', root: 'archived', cwd: '/project', title: 'Archived work', updatedAt: 1, state: 'closed' },
    ] }),
    checkpoint: vi.fn<SessionsHistory['checkpoint']>().mockResolvedValue({ sessionId: 'archived', revision: 'history-1', branch: 'entry',
      leafId: 'entry', byteLength: new TextEncoder().encode(entries.map(entry => JSON.stringify(entry)).join('\n')).byteLength, transcriptDigest: 'fixture-digest' }),
    history: vi.fn<SessionsHistory['history']>().mockResolvedValue({ sessionId: 'archived', revision: 'history-1', branch: 'entry',
      startedAt: '2026-01-01T00:00:00.000Z', entries }),
  } satisfies SessionsHistory;
}
async function action(kind: 'tui' | 'acp', row: ReturnType<typeof extensionFixture>['elements'][number],
  plan: Parameters<ReturnType<typeof clientRoute>['answer']>[0]) {
  const client = route(kind, row.value);
  await vi.waitFor(() => expect(client.dialogs).toHaveLength(1)); client.answer(plan);
  await vi.waitFor(() => expect(client.pending).toHaveLength(1));
  const sent = client.pending[0]!.params;
  await client.accept(params => commitAction(row, params));
  await client.dispose();
  return sent;
}

describe.each(['tui', 'acp'] as const)('migrated extension defaults through no-hint %s clients', kind => {
  it('answers a real ask-user wizard only after a broker response, retaining option identities and comments', async () => {
    const h = fixture(); await h.install(askUser);
    let settled = false;
    const work = h.tool('ask_user', { questions: [
      { question: 'Choose checks', options: [{ title: 'Unit' }, { title: 'Integration' }], allowMultiple: true, allowFreeform: false, allowComment: true },
      { question: 'Explain the approach', allowFreeform: true },
    ] }).then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(h.forms).toHaveLength(1));
    const row = h.forms[0]!; expect(row.form.hint).toBeUndefined();
    const client = route(kind, row.form);
    await vi.waitFor(() => expect(client.dialogs).toHaveLength(1));
    const values = { 'q1.mode': 'selection', 'q1.selection': ['option1', 'option2'], 'q1.comment': 'Both required.',
      'q2.mode': 'freeform', 'q2.text': 'Preserve existing boundaries.' };
    client.answer({ actionId: 'submit', values });
    await vi.waitFor(() => expect(client.pending).toHaveLength(1));
    expect(client.pending[0]).toMatchObject({ op: 'interaction.answer', params: { answer: {
      kind: 'form', actionId: 'submit', outcome: 'submit', values,
    } } });
    expect(settled).toBe(false);
    await client.accept(params => commitForm(row, params));
    expect(await work).toMatchObject({ details: { status: 'answered', responses: {
      q1: { kind: 'selection', selections: ['Unit', 'Integration'], comment: 'Both required.' },
      q2: { kind: 'freeform', text: 'Preserve existing boundaries.' },
    } } });
  });

  it('treats a declined ask-user dialog as cancellation, not an empty successful answer', async () => {
    const h = fixture(); await h.install(askUser);
    const work = h.tool('ask_user', { question: 'Continue?' });
    await vi.waitFor(() => expect(h.forms).toHaveLength(1));
    const row = h.forms[0]!; const client = route(kind, row.form);
    await vi.waitFor(() => expect(client.dialogs).toHaveLength(1)); client.answer('decline');
    await vi.waitFor(() => expect(client.pending).toHaveLength(1));
    expect(client.pending[0]).toMatchObject({ params: { answer: { cancelled: true, reason: 'user' } } });
    await client.accept(params => commitForm(row, params));
    expect(await work).toMatchObject({ details: { status: 'cancelled' } });
  });

  it('declines the default Prewalk entry using the explicit cancel action without starting model selection', async () => {
    const h = fixture(); await h.install(prewalk, { entryApproval: 'ask' });
    const work = h.tool('enter_prewalk', {});
    const declined = expect(work).rejects.toThrow('Prewalk entry was not approved');
    await vi.waitFor(() => expect(h.forms).toHaveLength(1));
    const row = h.forms[0]!;
    expect(row.form.actions.map(action => action.id)).toEqual(['enter', 'cancel']);
    const client = route(kind, row.form);
    await vi.waitFor(() => expect(client.dialogs).toHaveLength(1)); client.answer({ actionId: 'cancel' });
    await vi.waitFor(() => expect(client.pending).toHaveLength(1));
    expect(client.pending[0]).toMatchObject({ params: { answer: { actionId: 'cancel', outcome: 'cancel', values: {} } } });
    await client.accept(params => commitForm(row, params));
    await declined;
  });

  it('preserves explicit Prewalk review IDs and feedback through its default portable UI adapter', async () => {
    const h = fixture(); const adapter = createPrewalkUiHost(h.api.ui); cleanups.push(() => adapter.dispose());
    const work = adapter.host.review(h.context, '# Plan\n\nKeep the public API.', h.context.signal);
    await vi.waitFor(() => expect(h.forms).toHaveLength(1));
    const row = h.forms[0]!;
    expect(row.form.actions.map(action => action.id)).toEqual(['approve', 'feedback', 'cancel']);
    const client = route(kind, row.form);
    await vi.waitFor(() => expect(client.dialogs).toHaveLength(1));
    client.answer({ actionId: 'feedback', values: { feedback: 'Add cancellation coverage.' } });
    await vi.waitFor(() => expect(client.pending).toHaveLength(1));
    expect(client.pending[0]).toMatchObject({ params: { answer: { actionId: 'feedback', outcome: 'submit', values: { feedback: 'Add cancellation coverage.' } } } });
    await client.accept(params => commitForm(row, params));
    expect(await work).toEqual({ action: 'Provide feedback', feedback: 'Add cancellation coverage.' });
  });

  it('pages, queries and reads the default Tasks view; only declared actions mutate task state', async () => {
    const h = fixture(); await h.install(tasks);
    for (let i = 0; i < 25; i++) await h.tool('TaskCreate', { title: `Task ${i}`, description: `Complete detail ${i}` });
    const work = h.command('tasks');
    await vi.waitFor(() => expect(h.elements).toHaveLength(1));
    let row = h.elements.at(-1)!;
    expect(row.value.hint).toBeUndefined();
    expect(row.value).toMatchObject({ kind: 'view', items: expect.any(Array) });
    await action(kind, row, { actionId: 'next' });
    expect(row.value).toMatchObject({ items: expect.any(Array) });
    if (row.value.kind !== 'view') throw new Error('Expected tasks view.');
    expect(row.value.items).toHaveLength(5);
    await action(kind, row, { actionId: 'filter', values: { filter: 'all', search: 'Task 24' } });
    if (row.value.kind !== 'view') throw new Error('Expected filtered tasks.');
    expect(row.value.items).toHaveLength(1);
    const id = row.value.items[0]!.id;
    const sent = await action(kind, row, { actionId: 'detail', itemId: id });
    expect(sent).toMatchObject({ actionId: 'detail', itemId: id, values: {} });
    row = h.elements.at(-1)!;
    expect(row.value).toMatchObject({ kind: 'document', markdown: expect.stringContaining('Complete detail 24') });
    await action(kind, row, { actionId: 'back' });
    row = h.elements.at(-1)!;
    await action(kind, row, { actionId: 'create', values: { title: 'Created explicitly through UI' } });
    expect((await h.tool('TaskList', { view: 'all', limit: 100 }))).toMatchObject({ details: {
      tasks: expect.arrayContaining([expect.objectContaining({ title: 'Created explicitly through UI' })]),
    } });
    await action(kind, h.elements.at(-1)!, { actionId: 'close' }); await work;
  });

  it('opens the default ContextView document and closes only through its canonical action', async () => {
    const h = fixture(); await h.install(contextView);
    const work = h.command('context');
    await vi.waitFor(() => expect(h.elements).toHaveLength(1));
    const row = h.elements[0]!;
    expect(row.value).toMatchObject({ kind: 'document', title: 'Context usage', markdown: expect.stringContaining('Used: 5 / 8.2k') });
    const sent = await action(kind, row, { actionId: 'close' });
    expect(sent).toMatchObject({ elementId: row.value.id, revision: 1, actionId: 'close', outcome: 'cancel', values: {} });
    await work; expect(row.closed).toBe(true);
  });

  it('renders default Powerline views and typed statuses after stripping the optional footer hint', async () => {
    const h = fixture(); await h.install(powerline); await h.emit('session_start');
    await vi.waitFor(() => expect(h.elements.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(h.statuses.length).toBeGreaterThan(0));
    for (const source of [h.elements[0]!.value, h.statuses[0]!]) {
      expect(parseUiPresentation(source)).toEqual(source); expect(source.hint).toBeUndefined();
      const client = route(kind, source);
      await vi.waitFor(() => expect(kind === 'tui' ? vi.mocked(client.ui.custom).mock.calls.length : client.send.mock.calls.length).toBeGreaterThan(0));
      const rendered = kind === 'tui' ? client.displays.join('\n')
        : client.send.mock.calls.map(([update]) => update.content.text).join('\n').replace(/\\([\\`*_{}\[\]()#+.!|~\-])/gu, '$1');
      expect(rendered).toContain(source.kind === 'status' ? source.key : 'fixture-model');
      expect(client.pending).toHaveLength(0);
      await client.dispose();
    }
    expect(h.api.exec).toHaveBeenCalled();
    await h.emit('session_shutdown');
    expect(h.elements.every(row => row.closed)).toBe(true);
  });

  it('queries default PromptHistory through shared Sessions and reads full text without submitting a prompt', async () => {
    const h = fixture(); const history = historyFixture(`Read the complete historical prompt without running it. ${'界'.repeat(9000)}`);
    h.services.set(SESSIONS_HISTORY_SERVICE, history);
    h.entries.push(userEntry('current', 'Current live prompt'));
    expect(promptHistory.serviceRequirements).toEqual({ required: [SESSIONS_HISTORY_SERVICE] });
    await h.install(promptHistory); await h.command('prompt-history');
    await vi.waitFor(() => expect(h.elements[0]?.value).toMatchObject({ kind: 'view', items: expect.any(Array) }));
    const row = h.elements[0]!;
    await vi.waitFor(() => { if (row.value.kind !== 'view') throw new Error('Expected view'); expect(row.value.items).toHaveLength(1); });
    expect(history.list).not.toHaveBeenCalled();
    await action(kind, row, { actionId: 'search', values: { query: 'historical', scope: 'project' } });
    await vi.waitFor(() => expect(history.history).toHaveBeenCalled());
    await vi.waitFor(() => { if (row.value.kind !== 'view') throw new Error('Expected view'); expect(row.value.items).toHaveLength(1); });
    expect(history.history.mock.calls[0]?.[1]?.at).toEqual({ sessionId: 'archived', revision: 'history-1', branch: 'entry' });
    if (row.value.kind !== 'view') throw new Error('Expected view');
    await action(kind, row, { actionId: 'detail', itemId: row.value.items[0]!.id });
    const detail = h.elements.at(-1)!;
    expect(detail.value).toMatchObject({ kind: 'document', markdown: expect.stringContaining('complete historical prompt') });
    let text = detail.value.kind === 'document' ? detail.value.markdown : '';
    let pages = 1;
    while (detail.value.kind !== 'status' && detail.value.actions.some(action => action.id === 'next')) {
      await action(kind, detail, { actionId: 'next' }); pages++;
      if (detail.value.kind !== 'document') throw new Error('Expected full prompt document.');
      text += detail.value.markdown;
    }
    expect(pages).toBeGreaterThan(1); expect(text.match(/界/gu)).toHaveLength(9000);
    expect(h.context.executeTool).not.toHaveBeenCalled();
    expect(history).not.toHaveProperty('create'); expect(history).not.toHaveProperty('steer');
    await action(kind, detail, { actionId: 'close' });
  });

  it('generates default Insights from pinned read-only Sessions and displays the actual report', async () => {
    const h = fixture(); const history = historyFixture(); h.services.set(SESSIONS_HISTORY_SERVICE, history);
    expect(insights.serviceRequirements).toEqual({ required: [SESSIONS_HISTORY_SERVICE] });
    await h.install(insights); await h.command('insights');
    expect(history.history.mock.calls[0]?.[1]?.at).toEqual({ sessionId: 'archived', revision: 'history-1', branch: 'entry' });
    expect(h.elements).toHaveLength(1);
    const source = h.elements[0]!.value;
    expect(source).toMatchObject({ kind: 'document', markdown: expect.any(String) });
    expect(source.hint).toBeUndefined();
    const client = route(kind, source);
    await vi.waitFor(() => expect(client.dialogs).toHaveLength(1));
    expect(kind === 'tui' ? client.displays.join('\n') : JSON.stringify(client.acpRequest.mock.calls)).toContain('Felan Code Insights Report');
    expect(h.storage.writeFile).toHaveBeenCalled();
    expect(history).not.toHaveProperty('create'); expect(history).not.toHaveProperty('steer');
    client.answer({ actionId: 'close' });
    await vi.waitFor(() => expect(client.pending).toHaveLength(1));
    await client.accept(params => commitAction(h.elements[0]!, params));
    expect(h.elements[0]!.closed).toBe(true);
  });
});

it.each(['tui', 'acp'] as const)('fences stale and disconnected real task dialogs before %s dispatch', async kind => {
  const h = fixture(); await h.install(tasks); await h.tool('TaskCreate', { title: 'Original task' });
  const work = h.command('tasks'); await vi.waitFor(() => expect(h.elements).toHaveLength(1));
  const row = h.elements[0]!; const original = structuredClone(row.value); const client = route(kind, original);
  await vi.waitFor(() => expect(client.dialogs).toHaveLength(1));
  await action(kind, row, { actionId: 'filter', values: { filter: 'all', search: 'Original' } });
  client.update(row.value);
  await vi.waitFor(() => expect(client.dialogs).toHaveLength(2));
  expect(client.dialogs[0]!.signal.aborted).toBe(true);
  client.answer({ actionId: 'refresh' }, 0); await Promise.resolve();
  expect(client.pending).toHaveLength(0);
  const current = row.value;
  if (current.kind === 'status') throw new Error('Expected interactive tasks view.');
  expect(() => validateUiAction(current, { elementId: original.id, revision: 'revision' in original ? original.revision : 0,
    actionId: 'refresh', outcome: 'submit', values: {} })).toThrow();
  client.connection(false);
  await vi.waitFor(() => expect(client.dialogs[1]!.signal.aborted).toBe(true));
  client.answer({ actionId: 'refresh' }, 1); client.connection(true);
  await vi.waitFor(() => expect(client.dialogs).toHaveLength(3));
  client.answer({ actionId: 'close' }, 2);
  await vi.waitFor(() => expect(client.pending).toHaveLength(1));
  await client.accept(params => commitAction(row, params)); await work;
  expect(client.pending[0]).toMatchObject({ params: { actionId: 'close', revision: 'revision' in row.value ? row.value.revision : 0 } });
});

it.each(['tui', 'acp'] as const)('does not turn unnegotiated generic form support into %s answers', async kind => {
  const h = fixture(); await h.install(askUser); const work = h.tool('ask_user', { question: 'Needs an eligible client' });
  await vi.waitFor(() => expect(h.forms).toHaveLength(1));
  const client = route(kind, h.forms[0]!.form, [], []);
  await Promise.resolve(); await Promise.resolve();
  expect(client.dialogs).toHaveLength(0); expect(client.pending).toHaveLength(0);
  h.forms[0]!.reply({ state: 'cancelled', reason: 'unsupported' });
  expect(await work).toMatchObject({ details: { status: 'cancelled' }, isError: true });
});

it('keeps Fusion unavailable without Models and Models tool-only behavior without inventing generic widgets', async () => {
  const h = fixture(); expect(fusion.serviceRequirements).toEqual({ optional: [MODELS_SERVICE] });
  await h.install(fusion); await h.command('fusion-models');
  expect(h.api.ui.notify).toHaveBeenCalledWith({ level: 'warning', text: 'Fusion requires a configured Models service.' });
  expect(h.forms).toHaveLength(0); expect(h.elements).toHaveLength(0);
  const models: ModelsService = {
    getAvailable: vi.fn(async () => []), getAvailableOfType: vi.fn(async () => []),
    completeSimple: vi.fn(async () => { throw new Error('No inference permitted.'); }),
    streamSimple: vi.fn(() => { throw new Error('No inference permitted.'); }),
    generateImages: vi.fn(async () => { throw new Error('No inference permitted.'); }),
  };
  expect(modelTools.serviceRequirements).toEqual({ optional: [MODELS_SERVICE] });
  h.services.set(MODELS_SERVICE, models); await h.install(modelTools);
  expect(models.getAvailableOfType).toHaveBeenCalledExactlyOnceWith('image');
  expect(models.generateImages).not.toHaveBeenCalled();
  expect(h.forms).toHaveLength(0); expect(h.elements).toHaveLength(0);
});
