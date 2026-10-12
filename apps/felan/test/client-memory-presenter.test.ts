import { expect, it, vi } from 'vitest';
import { MEMORY_VIEW_PRESENTER, encodeMemoryDocument, type MemoryViewDocument } from '@felan-ai/ext-memory/view';
import type { Interaction, Presentation } from '@felan-ai/session-protocol';
import { ClientInteractionPresenters, type InteractionPresenterUi } from '../src/client/presenters.js';
import { registerMemoryPresenter } from '../src/client/memory-presenter.js';

it('assembles bounded catalog chunks and keeps the original picker controls', async () => {
  const document: MemoryViewDocument = { kind: 'catalog', sessions: [{ key: 'key', id: 'run', path: '/run', cwd: '/fixture',
    created: 1, modified: 2, messageCount: 1, firstMessage: 'retained', allMessagesText: 'many words '.repeat(10000),
    project: { canonicalRoot: '/fixture', key: 'project' }, manifestPath: '/manifest' }], current: ['key'] };
  const encoded = encodeMemoryDocument(document); let page: Presentation | undefined;
  const custom = vi.fn(async (factory: (...args: unknown[]) => unknown) => {
    let selected: unknown;
    const view = factory({ terminal: { rows: 24 }, requestRender() {} }, { fg: (_key: string, text: string) => text }, {}, (value: unknown) => { selected = value; }) as { handleInput(data: string): void };
    view.handleInput('\r'); return selected;
  });
  const ui = { custom, notify: vi.fn() } as unknown as InteractionPresenterUi;
  const presenters = new ClientInteractionPresenters(ui);
  const remove = registerMemoryPresenter(presenters, ui, { read: () => page ? [page] : [], subscribe: () => () => {} });
  try {
    for (let index = 0; index < encoded.chunks.length; index++) {
      page = { id: 'memory:view', kind: 'custom', presenter: MEMORY_VIEW_PRESENTER, data: { viewId: 'view', documentId: 'document', index, text: encoded.chunks[index]! } };
      const interaction: Interaction = { id: `interaction-${index}`, state: 'waiting', createdAt: 1, eligibleClientKinds: ['tui'],
        scope: { kind: 'session', session: 'session', root: 'session' }, request: { kind: 'custom', presenter: MEMORY_VIEW_PRESENTER,
          data: { viewId: 'view', documentId: 'document', index, sequence: index + 1, kind: 'catalog', chunks: encoded.chunks.length, bytes: encoded.bytes, status: 'ready' } } };
      const result = await presenters.present(interaction, new AbortController().signal);
      expect(result).toMatchObject({ state: 'answered', answer: { data: index < encoded.chunks.length - 1
        ? { action: 'chunk', index: index + 1 } : { action: 'inspect', key: 'key' } } });
    }
    expect(custom).toHaveBeenCalledOnce();
  } finally { remove(); }
});

it('restores the selected transcript after a cold reconnect without a cached catalog', async () => {
  const row = { key: 'key', id: 'run', path: '/run', cwd: '/fixture', created: 1, modified: 2, messageCount: 0,
    firstMessage: '', allMessagesText: '', project: { canonicalRoot: '/fixture', key: 'project' }, manifestPath: '/manifest' };
  let page: Presentation | undefined; let sequence = 0;
  const ui = { custom: vi.fn(), notify: vi.fn() } as unknown as InteractionPresenterUi;
  const presenters = new ClientInteractionPresenters(ui);
  const remove = registerMemoryPresenter(presenters, ui, { read: () => page ? [page] : [], subscribe: () => () => {} });
  const send = async (document: MemoryViewDocument, documentId: string) => {
    const encoded = encodeMemoryDocument(document); expect(encoded.chunks).toHaveLength(1);
    page = { id: 'memory:view', kind: 'custom', presenter: MEMORY_VIEW_PRESENTER,
      data: { viewId: 'view', documentId, index: 0, text: encoded.chunks[0]! } };
    return presenters.present({ id: `interaction-${++sequence}`, state: 'waiting', createdAt: 1, eligibleClientKinds: ['tui'],
      scope: { kind: 'session', session: 'session', root: 'session' }, request: { kind: 'custom', presenter: MEMORY_VIEW_PRESENTER,
        data: { viewId: 'view', documentId, index: 0, sequence, kind: document.kind, chunks: 1, bytes: encoded.bytes, status: 'ready' } } }, new AbortController().signal);
  };
  try {
    expect(await send({ kind: 'snapshot', session: row, messages: [], diagnostics: [] }, 'snapshot')).toMatchObject({ state: 'answered', answer: { data: { action: 'back' } } });
    expect(await send({ kind: 'catalog', sessions: [row], current: ['key'] }, 'catalog')).toMatchObject({ state: 'answered', answer: { data: { action: 'inspect', key: 'key' } } });
    expect(ui.custom).not.toHaveBeenCalled();
  } finally { remove(); }
});
