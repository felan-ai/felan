import { expect, it, vi } from 'vitest';
import { PROMPT_HISTORY_PRESENTER, parsePromptHistoryRequest, parsePromptHistoryText } from '@felan-ai/ext-prompt-history/view';
import type { PromptHistorySearchState } from '@felan-ai/ext-prompt-history';
import type { Presentation } from '@felan-ai/session-protocol';
import { createBrokerPromptHistoryHost } from '../src/daemon/prompt-history-view.js';
import { gate } from './fixtures/server.js';

it('keeps search execution server-side and delivers the complete selected prompt outside durable answers', async () => {
  const text = 'needle😀\n'.repeat(20000); const presentations: Presentation[] = []; const scopes: string[] = [];
  let browse = 0; const chunks: string[] = [];
  const host = createBrokerPromptHistoryHost({ signal: new AbortController().signal,
    present(value) { if (!('remove' in value)) presentations.push(value); }, unsupported: () => { throw new Error('unsupported'); },
    async request(value) {
      if (value.kind !== 'custom') throw new Error(); const request = parsePromptHistoryRequest(value.data);
      let choice: object;
      if (request.kind === 'browse') {
        if (++browse === 1) choice = { action: 'search', query: 'needle', scope: 'all' };
        else {
          const frame = presentations.at(-1)!; if (frame.kind !== 'custom') throw new Error();
          choice = { action: 'choose', id: (frame.data as unknown as PromptHistorySearchState).items[0]!.id };
        }
      } else {
        const frame = presentations.at(-1)!; if (frame.kind !== 'custom') throw new Error();
        chunks.push(parsePromptHistoryText(frame.data).text);
        choice = request.index === request.chunks - 1 ? { action: 'insert' } : { action: 'chunk', index: request.index + 1 };
      }
      return { state: 'answered', answer: { kind: 'custom', presenter: PROMPT_HISTORY_PRESENTER,
        data: { ...choice, viewId: request.viewId, generation: request.generation } as never } };
    },
  });
  await host.show({} as never, async (scope, _query, progress) => {
    scopes.push(scope); const state = { items: [{ id: 'private/path:item', text, cwd: '/private/work', sessionLabel: 'source.jsonl', timestamp: 1 }], loading: false, scanned: 1, total: 1, complete: true };
    progress(state); return state;
  }, 'overlay', new AbortController().signal);
  expect(scopes).toEqual(['session', 'all']); expect(chunks.join('')).toBe(text);
  const frame = presentations[1]!; expect(JSON.stringify(frame)).not.toContain('private/path:item');
});

it('cancels and joins in-flight reads before view shutdown', async () => {
  const entered = gate(); const release = gate(); const cancelled = gate(); let completed = false;
  const host = createBrokerPromptHistoryHost({ signal: new AbortController().signal, present() {}, unsupported: () => { throw new Error(); },
    async request(value, options) {
      if (value.kind !== 'custom') throw new Error(); const request = parsePromptHistoryRequest(value.data);
      options.signal.addEventListener('abort', cancelled.resolve, { once: true });
      await entered.promise;
      return { state: 'answered', answer: { kind: 'custom', presenter: PROMPT_HISTORY_PRESENTER,
        data: { action: 'close', viewId: request.viewId, generation: request.generation } } };
    },
  });
  const work = host.show({} as never, async (_scope, _query, progress, current) => {
    entered.resolve(); await release.promise; expect(current()).toBe(false);
    const state = { items: [], loading: false, scanned: 0, complete: true }; progress(state); return state;
  }, 'inline', new AbortController().signal).then(() => { completed = true; });
  try { await cancelled.promise; expect(completed).toBe(false); } finally { release.resolve(); await work; }
});

it('surfaces search failures rather than presenting an empty successful history', async () => {
  const host = createBrokerPromptHistoryHost({ signal: new AbortController().signal, present() {}, unsupported: () => { throw new Error(); },
    async request(_value, { signal }) { return await new Promise(resolve => { const done = () => resolve({ state: 'cancelled', reason: 'abort' } as const); if (signal.aborted) done(); else signal.addEventListener('abort', done, { once: true }); }); },
  });
  await expect(host.show({} as never, vi.fn().mockRejectedValue(new Error('read failed')), 'inline', new AbortController().signal)).rejects.toThrow('read failed');
});

it('accepts a recently displayed choice when a newer progress frame overtakes its selection', async () => {
  let selectedId = ''; let inserted = '';
  const host = createBrokerPromptHistoryHost({ signal: new AbortController().signal,
    present(value) {
      if ('remove' in value || value.kind !== 'custom') return;
      const data = value.data as Record<string, unknown>;
      if (!selectedId && Array.isArray(data.items) && data.items.length) selectedId = (data.items[0] as { id: string }).id;
      if (typeof data.text === 'string') inserted += data.text;
    }, unsupported: () => { throw new Error(); },
    async request(value) {
      if (value.kind !== 'custom') throw new Error(); const request = parsePromptHistoryRequest(value.data);
      return { state: 'answered', answer: { kind: 'custom', presenter: PROMPT_HISTORY_PRESENTER, data: {
        viewId: request.viewId, generation: request.generation,
        ...(request.kind === 'browse' ? { action: 'choose', id: selectedId } : { action: 'insert' }),
      } } };
    },
  });
  await host.show({} as never, async (_scope, _query, progress) => {
    const state = { loading: true, scanned: 1, total: 2, complete: false };
    progress({ ...state, items: [{ id: 'first', text: 'selected original', cwd: '/w', sessionLabel: 's', timestamp: 1 }] });
    const final = { ...state, loading: false, scanned: 2, complete: true, items: [{ id: 'new', text: 'later result', cwd: '/w', sessionLabel: 's', timestamp: 2 }] };
    progress(final); return final;
  }, 'inline', new AbortController().signal);
  expect(inserted).toBe('selected original');
});
