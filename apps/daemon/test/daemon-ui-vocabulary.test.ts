import { describe, expect, it, vi } from 'vitest';
import type { ExtensionUi, UiActionContext, UiElementHandle, UiRequestResult } from '@felan-ai/agent-core';
import type { UiActionRequest, UiDocument, UiForm, UiStatus, UiView } from '@felan-ai/session-protocol';
import {
  createUiVocabulary, type UiVocabularyCallbacks, type UiVocabularyRequestOptions, type UiVocabularyUpdate,
} from '../src/daemon/ui-vocabulary.js';

const document = (revision = 1): UiDocument => ({
  id: 'shared', kind: 'document', revision, title: 'Plan', markdown: 'Review this plan.', fallback: 'Review this plan.',
  actions: [{ id: 'approve', label: 'Approve', target: 'element', outcome: 'submit' }],
});
const form = (): UiForm => ({
  title: 'Review', fallback: 'Approve or cancel.',
  input: { fields: [{ id: 'note', kind: 'string', label: 'Note', required: true, maxLength: 100 }], defaults: { note: 'Default' } },
  actions: [
    { id: 'approve', label: 'Approve', target: 'element', outcome: 'submit' },
    { id: 'cancel', label: 'Cancel', target: 'element', outcome: 'cancel' },
  ],
});
const status = (): UiStatus => ({
  id: 'shared', kind: 'status', key: 'shared', value: { kind: 'tokens', value: 3 }, fallback: '3 tokens',
});
const context = (id = 'request'): UiActionContext => ({ requestId: id, signal: new AbortController().signal });
const action = (elementId: string, revision = 1): UiActionRequest => ({
  elementId, revision, actionId: 'approve', outcome: 'submit', values: {},
});

function fixture(overrides: Partial<UiVocabularyCallbacks> = {}) {
  const updates: UiVocabularyUpdate[] = [];
  const publish = vi.fn<UiVocabularyCallbacks['publish']>(async update => { updates.push(update); });
  const request = vi.fn<UiVocabularyCallbacks['request']>(async () => ({ state: 'cancelled', reason: 'unsupported' }));
  return { ...createUiVocabulary({ canRequest: () => true, publish, request, ...overrides }), updates, publish, request };
}

function documentId(updates: UiVocabularyUpdate[], index = 0): string {
  return updates.filter(update => 'kind' in update && update.kind === 'document')[index]!.id;
}

describe('generic daemon UI vocabulary', () => {
  it('checks form availability without publishing or requesting a response', async () => {
    const canRequest = vi.fn(() => false);
    const f = fixture({ canRequest });
    expect(f.createExtensionUi('extension').canRequest(form(), { audience: 'host' })).toBe(false);
    expect(canRequest).toHaveBeenCalledWith(form(), { audience: 'host' });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    await f.dispose();
  });

  it.each(['session', 'owner', undefined] as const)('rejects transient forms for audience %s', async audience => {
    const f = fixture();
    await expect(f.createExtensionUi('extension').request(form(), { audience, transient: true }))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.request).not.toHaveBeenCalled();
    await f.dispose();
  });
  it.each(['session', 'owner', 'host'] as const)('preserves %s request audience through the Core binding', async audience => {
    const f = fixture();
    await f.createExtensionUi('extension').request(form(), { audience });
    expect(f.request).toHaveBeenCalledWith(form(), expect.objectContaining({ audience }));
    await f.dispose();
  });

  it.each([true, false, undefined])('preserves the explicit deferral option: %s', async deferrable => {
    const f = fixture({ request: async (_form, options) => options.deferrable
      ? { state: 'deferred', interactionId: 'deferred-form' }
      : { state: 'cancelled', reason: 'drain' } });
    const result = await f.createExtensionUi('extension').request(form(), { deferrable });
    expect(result).toEqual(deferrable ? { state: 'deferred', interactionId: 'deferred-form' } : { state: 'cancelled', reason: 'drain' });
    await f.dispose();
  });

  it('forwards transient requests and rejects transient deferral', async () => {
    const f = fixture();
    const ui = f.createExtensionUi('extension');
    await ui.request(form(), { audience: 'host', transient: true, deferrable: false });
    expect(f.request).toHaveBeenCalledWith(form(), expect.objectContaining({ transient: true, deferrable: false }));
    f.request.mockClear();
    await expect(ui.request(form(), { transient: true, deferrable: true })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.request).not.toHaveBeenCalled();
    await f.dispose();
  });

  it('namespaces element and status IDs and routes only registered wire actions to their owner', async () => {
    const f = fixture();
    const first = f.createExtensionUi('first');
    const second = f.createExtensionUi('second');
    const firstAction = vi.fn(async () => {});
    const secondAction = vi.fn(async () => {});
    const firstHandle = await first.present(document(), { onAction: firstAction });
    await second.present(document(), { onAction: secondAction });
    await first.status(status());
    await second.status(status());
    const ids = f.updates.map(update => update.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids).not.toContain('shared');
    const statuses = f.updates.filter(update => 'kind' in update && update.kind === 'status');
    expect(statuses.map(item => 'key' in item ? item.key : undefined)).toEqual([status().key, status().key]);
    await f.dispatch(action(ids[0]!), context());
    expect(firstAction).toHaveBeenCalledWith(action('shared'), expect.objectContaining({ requestId: 'request' }));
    expect(secondAction).not.toHaveBeenCalled();
    await expect(f.dispatch(action('shared'), context())).rejects.toMatchObject({ code: 'stale_request' });
    const foreign = fixture();
    await expect(foreign.dispatch(action(ids[0]!), context())).rejects.toMatchObject({ code: 'stale_request' });
    await expect(second.removeStatus(ids[2]!)).rejects.toMatchObject({ code: 'stale_request' });
    await firstHandle.close();
    await expect(f.dispatch(action(ids[0]!), context())).rejects.toMatchObject({ code: 'stale_request' });
    await Promise.all([f.dispose(), foreign.dispose()]);
  });

  it('revokes old bindings and handles on reload without touching replacement IDs', async () => {
    const f = fixture();
    const old = f.createExtensionUi('extension');
    const handler = vi.fn(async () => {});
    const handle = await old.present(document(), { onAction: handler });
    const oldId = documentId(f.updates);
    const current = f.createExtensionUi('extension');
    await current.present(document(), { onAction: handler });
    const newId = documentId(f.updates, 1);
    expect(newId).not.toBe(oldId);
    await expect(old.notify({ level: 'info', text: 'Old' })).rejects.toThrow('inactive');
    await expect(handle.update(document(2))).rejects.toThrow();
    await expect(f.dispatch(action(oldId), context())).rejects.toMatchObject({ code: 'stale_request' });
    await f.dispatch(action(newId), context());
    expect(f.updates).toContainEqual({ id: oldId, remove: true });
    expect(f.updates).not.toContainEqual({ id: newId, remove: true });
    await f.dispose();
  });

  it('validates forms, defaults and answers without treating defaults or hints as approval', async () => {
    const f = fixture();
    const ui = f.createExtensionUi('extension');
    await expect(ui.request({ ...form(), input: { ...form().input, defaults: { other: 'Unknown' } } }))
      .rejects.toMatchObject({ code: 'invalid_request' });
    await expect(ui.request({ ...form(), markdown: '<script>unsafe</script>' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.request).not.toHaveBeenCalled();
    f.request.mockResolvedValueOnce({ state: 'answered', answer: { kind: 'form', actionId: 'approve', outcome: 'submit', values: {} } });
    await expect(ui.request(form())).rejects.toMatchObject({ code: 'invalid_request' });
    f.request.mockResolvedValueOnce({ state: 'answered', answer: { kind: 'form', actionId: 'cancel', outcome: 'submit', values: { note: 'x' } } });
    await expect(ui.request(form())).rejects.toMatchObject({ code: 'invalid_request' });
    const answer: UiRequestResult = { state: 'answered', answer: { kind: 'form', actionId: 'cancel', outcome: 'cancel', values: {} } };
    f.request.mockResolvedValue(answer);
    await expect(ui.request({ ...form(), hint: { id: 'unknown.renderer', version: '999' } }, { audience: 'owner', timeoutMs: 500 }))
      .resolves.toEqual(answer);
    expect(f.request.mock.calls.at(-1)?.[1]).toMatchObject({ audience: 'owner', timeoutMs: 500, bindingId: expect.any(String) });
    f.request.mockResolvedValueOnce({ state: 'deferred', interactionId: 'pending' });
    await expect(ui.request(form())).resolves.toEqual({ state: 'deferred', interactionId: 'pending' });
    expect(f.request.mock.calls.at(-1)?.[1].audience).toBe('session');
    await f.dispose();
  });

  it('validates presentations, handlers, action inputs and strictly increasing updates', async () => {
    const f = fixture();
    const ui = f.createExtensionUi('extension');
    await expect(ui.present(document())).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(ui.present({ ...document(), markdown: '<b>unsafe</b>' }, { onAction: async () => {} }))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.publish).not.toHaveBeenCalled();
    const source = { ...document(), hint: { id: 'not-installed', version: '1' } };
    const handler = vi.fn(async () => {});
    const handle = await ui.present(source, { onAction: handler });
    const id = documentId(f.updates);
    source.actions.length = 0;
    await f.dispatch(action(id), context());
    expect(handler).toHaveBeenCalledOnce();
    await expect(f.dispatch({ ...action(id), values: { unexpected: 'input' } }, context())).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(f.dispatch({ ...action(id), outcome: 'cancel' }, context())).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(handle.update(document())).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(handle.update({ ...document(2), id: 'other' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(handle.update({ id: 'shared', kind: 'progress', revision: 2, label: 'Work',
      state: 'running', actions: [], fallback: 'Work' })).rejects.toMatchObject({ code: 'invalid_request' });
    await handle.update(document(2));
    await expect(f.dispatch(action(id), context())).rejects.toMatchObject({ code: 'stale_request' });
    await f.dispatch(action(id, 2), context());
    const readOnly = await ui.present({ ...document(), id: 'read-only', actions: [] });
    await expect(readOnly.update({ ...document(2), id: 'read-only' })).rejects.toMatchObject({ code: 'invalid_request' });
    await f.dispose();
  });

  it('validates view item membership and action-specific input', async () => {
    const f = fixture();
    const ui = f.createExtensionUi('extension');
    const view: UiView = {
      id: 'view', kind: 'view', revision: 1, title: 'Rows', fallback: 'Choose a row.',
      fields: [{ id: 'name', label: 'Name', valueKind: 'text' }],
      items: [{ id: 'row', values: { name: 'Example' }, fallback: 'Example' }],
      actions: [{ id: 'approve', label: 'Edit', target: 'item', outcome: 'submit', input: form().input }],
    };
    const handler = vi.fn(async () => {});
    await ui.present(view, { onAction: handler });
    const id = f.updates[0]!.id;
    await expect(f.dispatch({ ...action(id), itemId: 'other', values: { note: 'x' } }, context())).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(f.dispatch({ ...action(id), itemId: 'row' }, context())).rejects.toMatchObject({ code: 'invalid_request' });
    await f.dispatch({ ...action(id), itemId: 'row', values: { note: 'Edited' } }, context());
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ elementId: 'view', itemId: 'row', values: { note: 'Edited' } }), expect.any(Object));
    await f.dispose();
  });

  it('serializes handlers and rechecks queued revisions after a preceding handler updates', async () => {
    const f = fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    let handle!: UiElementHandle;
    const handler = vi.fn(async () => { entered.resolve(); await release.promise; await handle.update(document(2)); });
    handle = await f.createExtensionUi('extension').present(document(), { onAction: handler });
    const id = documentId(f.updates);
    const first = f.dispatch(action(id), context('first'));
    await entered.promise;
    const second = expect(f.dispatch(action(id), context('second'))).rejects.toMatchObject({ code: 'stale_request' });
    expect(handler).toHaveBeenCalledOnce();
    release.resolve();
    await Promise.all([first, second]);
    expect(handler).toHaveBeenCalledOnce();
    await f.dispose();
  });

  it('prepares without effects and revalidates prepared actions after updates, close and reload', async () => {
    const f = fixture();
    const ui = f.createExtensionUi('extension');
    const handler = vi.fn(async () => {});
    const handle = await ui.present(document(), { onAction: handler });
    const id = documentId(f.updates);
    const updates = f.updates.length;
    for (const request of [action('foreign'), action(id, 2), { ...action(id), values: { undeclared: 'value' } }]) {
      expect(() => f.prepareAction(request)).toThrow();
    }
    const prepared = f.prepareAction(action(id));
    expect(handler).not.toHaveBeenCalled();
    expect(f.updates).toHaveLength(updates);
    await handle.update(document(2));
    await expect(prepared(context())).rejects.toMatchObject({ code: 'stale_request' });
    const closed = f.prepareAction(action(id, 2));
    await handle.close();
    expect(() => f.prepareAction(action(id, 2))).toThrow();
    await expect(closed(context())).rejects.toThrow();
    await ui.present(document(), { onAction: handler });
    const reloaded = f.prepareAction(action(documentId(f.updates, 2)));
    f.createExtensionUi('extension');
    await expect(reloaded(context())).rejects.toThrow('inactive');
    expect(handler).not.toHaveBeenCalled();
    await f.dispose();
  });

  it('propagates handler failures without poisoning subsequent dispatch', async () => {
    const f = fixture();
    const failure = new Error('handler failed');
    const handler = vi.fn(async () => {}).mockRejectedValueOnce(failure);
    await f.createExtensionUi('extension').present(document(), { onAction: handler });
    const id = documentId(f.updates);
    await expect(f.dispatch(action(id), context())).rejects.toBe(failure);
    await f.dispatch(action(id), context('next'));
    expect(handler).toHaveBeenCalledTimes(2);
    await f.dispose();
  });

  it('allows an admitted handler to close itself while rejecting queued and prepared actions', async () => {
    const f = fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    let handle!: UiElementHandle;
    const handler = vi.fn(async () => { entered.resolve(); await release.promise; await handle.close(); });
    handle = await f.createExtensionUi('extension').present(document(), { onAction: handler });
    const id = documentId(f.updates);
    const prepared = f.prepareAction(action(id));
    const first = f.dispatch(action(id), context('first'));
    await entered.promise;
    const queued = expect(f.dispatch(action(id), context('second'))).rejects.toMatchObject({ code: 'stale_request' });
    release.resolve();
    await first;
    await queued;
    await expect(prepared(context('third'))).rejects.toMatchObject({ code: 'stale_request' });
    expect(handler).toHaveBeenCalledOnce();
    await f.dispose();
  });

  it.each(['reload', 'caller'] as const)('retains %s cancellation fences for an active handler', async source => {
    const f = fixture();
    const entered = deferred<UiActionContext>();
    const release = deferred<void>();
    const handler = vi.fn(async (_action: UiActionRequest, ctx: UiActionContext) => { entered.resolve(ctx); await release.promise; });
    await f.createExtensionUi('extension').present(document(), { onAction: handler });
    const controller = new AbortController();
    const pending = expect(f.dispatch(action(documentId(f.updates)), { requestId: 'request', signal: controller.signal })).rejects.toThrow();
    const running = await entered.promise;
    if (source === 'reload') f.createExtensionUi('extension');
    else controller.abort();
    expect(running.signal.aborted).toBe(true);
    release.resolve();
    await pending;
    await f.dispose();
  });

  it('aborts requests on reload and awaits an ignored callback before disposal settles', async () => {
    const entered = deferred<UiVocabularyRequestOptions>();
    const response = deferred<UiRequestResult>();
    const f = fixture({ request: async (_form, options) => { entered.resolve(options); return response.promise; } });
    const pending = f.createExtensionUi('extension').request(form(), { audience: 'owner' });
    const options = await entered.promise;
    f.createExtensionUi('extension');
    await expect(pending).resolves.toEqual({ state: 'cancelled', reason: 'restart' });
    expect(options.signal.aborted).toBe(true);
    let disposed = false;
    const disposal = f.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    response.resolve({ state: 'answered', answer: { kind: 'form', actionId: 'approve', outcome: 'submit', values: { note: 'late' } } });
    await disposal;
  });

  it('retains a late failure from a cancelled request callback for disposal', async () => {
    const entered = deferred<void>();
    const response = deferred<UiRequestResult>();
    const failure = new Error('late request failure');
    const f = fixture({ request: async () => { entered.resolve(); return response.promise; } });
    const controller = new AbortController();
    const pending = f.createExtensionUi('extension').request(form(), { signal: controller.signal });
    await entered.promise;
    controller.abort();
    await expect(pending).resolves.toEqual({ state: 'cancelled', reason: 'abort' });
    const disposal = f.dispose();
    const rejected = expect(disposal).rejects.toMatchObject({ errors: [failure] });
    response.reject(failure);
    await rejected;
    expect(f.dispose()).toBe(disposal);
  });

  it('cancels pre-aborted requests without invoking the callback and enforces timeouts', async () => {
    const f = fixture();
    const ui = f.createExtensionUi('extension');
    const controller = new AbortController();
    controller.abort();
    await expect(ui.request(form(), { signal: controller.signal })).resolves.toEqual({ state: 'cancelled', reason: 'abort' });
    expect(f.request).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const response = deferred<UiRequestResult>();
    f.request.mockImplementationOnce(() => response.promise);
    try {
      const pending = ui.request(form(), { timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toEqual({ state: 'cancelled', reason: 'timeout' });
      response.resolve({ state: 'cancelled', reason: 'user' });
      await f.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('invalidates aborted presentation handlers and waits for running work at disposal', async () => {
    const f = fixture();
    const entered = deferred<UiActionContext>();
    const release = deferred<void>();
    const controller = new AbortController();
    const handler = vi.fn(async (_request: UiActionRequest, ctx: UiActionContext) => { entered.resolve(ctx); await release.promise; });
    const handle = await f.createExtensionUi('extension').present(document(), { signal: controller.signal, onAction: handler });
    const id = documentId(f.updates);
    const dispatch = expect(f.dispatch(action(id), context())).rejects.toThrow();
    const running = await entered.promise;
    controller.abort();
    expect(running.signal.aborted).toBe(true);
    await handle.close();
    await expect(f.dispatch(action(id), context('late'))).rejects.toMatchObject({ code: 'stale_request' });
    let done = false;
    const disposal = f.dispose().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    release.resolve();
    await Promise.all([dispatch, disposal]);
  });

  it('retains failed reload cleanup for disposal and still removes other presentations', async () => {
    const removed = deferred<void>();
    const failure = new Error('remove failed');
    const updates: UiVocabularyUpdate[] = [];
    const f = fixture({ publish: async update => {
      updates.push(update);
      if ('remove' in update && update.id.includes(':element:')) { removed.resolve(); throw failure; }
    } });
    const ui = f.createExtensionUi('extension');
    await ui.present(document(), { onAction: async () => {} });
    await ui.status(status());
    f.createExtensionUi('extension');
    await removed.promise;
    await Promise.resolve();
    const disposal = f.dispose();
    await expect(disposal).rejects.toMatchObject({ errors: [failure] });
    expect(f.dispose()).toBe(disposal);
    expect(updates.filter(update => 'remove' in update)).toHaveLength(2);
  });

  it('waits for in-flight publication before removing a superseded presentation', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const updates: UiVocabularyUpdate[] = [];
    const f = fixture({ publish: async update => {
      updates.push(update);
      if ('kind' in update && update.kind === 'document') { entered.resolve(); await release.promise; }
    } });
    const ui = f.createExtensionUi('extension');
    const presenting = expect(ui.present(document(), { onAction: async () => {} })).rejects.toThrow();
    await entered.promise;
    f.createExtensionUi('extension');
    let done = false;
    const disposal = f.dispose().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(updates).toHaveLength(1);
    release.resolve();
    await Promise.all([presenting, disposal]);
    expect(updates[1]).toEqual({ id: updates[0]!.id, remove: true });
  });

  it.each(['close', 'update', 'dispose'] as const)('rejects reentrant %s from a publisher instead of deadlocking', async operation => {
    let handle!: UiElementHandle;
    const f = fixture({ publish: async update => {
      if (!('revision' in update) || update.revision !== 2) return;
      if (operation === 'close') await handle.close();
      else if (operation === 'update') await handle.update(document(3));
      else await f.dispose();
    } });
    handle = await f.createExtensionUi('extension').present(document(), { onAction: async () => {} });
    await expect(handle.update(document(2))).rejects.toThrow('cannot reenter');
    await f.dispose();
  });

  it('allows callback-created timers to use UI after the publication has settled', async () => {
    vi.useFakeTimers();
    const later = deferred<void>();
    const updates: UiVocabularyUpdate[] = [];
    let ui!: ExtensionUi;
    const f = fixture({ publish: async update => {
      updates.push(update);
      if ('kind' in update && update.kind === 'document') {
        setTimeout(() => {
          void ui.notify({ level: 'info', text: 'Later update' }).then(() => later.resolve(), later.reject);
        }, 1);
      }
    } });
    try {
      ui = f.createExtensionUi('extension');
      await ui.present(document(), { onAction: async () => {} });
      const completed = expect(later.promise).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await completed;
      expect(updates).toContainEqual(expect.objectContaining({ kind: 'notification', text: 'Later update' }));
    } finally {
      await f.dispose();
      vi.useRealTimers();
    }
  });

  it('closes once when an abort listener reenters the same handle', async () => {
    const f = fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    let handle!: UiElementHandle;
    let reentrantClose: Promise<void> | undefined;
    const handler = async (_request: UiActionRequest, ctx: UiActionContext) => {
      ctx.signal.addEventListener('abort', () => { reentrantClose = handle.close(); }, { once: true });
      entered.resolve();
      await release.promise;
    };
    handle = await f.createExtensionUi('extension').present(document(), { onAction: handler });
    const id = documentId(f.updates);
    const dispatch = f.dispatch(action(id), context());
    await entered.promise;
    await handle.close();
    await reentrantClose;
    release.resolve();
    await dispatch;
    expect(f.updates.filter(update => 'remove' in update && update.id === id)).toHaveLength(1);
    await f.dispose();
  });

  it('keeps UI usable until explicit disposal and validates notifications and statuses', async () => {
    const f = fixture();
    const ui = f.createExtensionUi('extension');
    await Promise.resolve();
    await ui.notify({ level: 'info', text: 'Async shutdown update' });
    await expect(ui.notify({ level: 'info', text: 'x'.repeat(70_000) })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(ui.status({ ...status(), value: { kind: 'tokens', value: -1 } })).rejects.toMatchObject({ code: 'invalid_request' });
    await ui.status(status());
    await ui.removeStatus('shared');
    await f.dispose();
    await expect(ui.notify({ level: 'info', text: 'Too late' })).rejects.toThrow('inactive');
    expect(() => f.createExtensionUi('extension')).toThrow('disposed');
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
