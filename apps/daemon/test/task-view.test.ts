import { describe, expect, it, vi } from 'vitest';
import type { ExtensionContext } from '@felan-ai/agent-core';
import type { TaskDataSource, TaskState } from '@felan-ai/ext-tasks';
import { TASKS_PRESENTER } from '@felan-ai/ext-tasks/view';
import { parseSchema, PresentationSchema, type Presentation } from '@felan-ai/session-protocol';
import { createBrokerTasksHost } from '../src/daemon/task-view.js';
import type { BrokerOutcome } from '../src/daemon/broker.js';

const state: TaskState = { schemaVersion: 1, revision: 1, tasks: [{ id: 'T-AAAAAA', title: 'Task', priority: 1,
  status: 'pending', blockedBy: [], createdAt: '2026', updatedAt: '2026', notes: 'Details' }] };
const close: BrokerOutcome = { state: 'answered', answer: { kind: 'custom', presenter: TASKS_PRESENTER, data: { action: 'close' } } };

describe('broker task view host', () => {
  it('publishes valid bounded data before the question and removes it after close', async () => {
    const publications = new Map<string, Presentation>(); const unsubscribe = vi.fn();
    const source: TaskDataSource = { snapshot: async () => state, subscribe: listener => { listener(state); return unsubscribe; } };
    const host = createBrokerTasksHost({ signal: new AbortController().signal,
      present(value) { if ('remove' in value) publications.delete(value.id); else publications.set(value.id, parseSchema(PresentationSchema, value)); },
      async request() { expect([...publications.values()].some(value => value.kind === 'custom' && typeof value.data === 'object' && value.data !== null && 'kind' in value.data && value.data.kind === 'manifest')).toBe(true); return close; },
      unsupported: () => { throw new Error('unsupported'); },
    });
    await host.show({} as ExtensionContext['ui'], source, 'inline', new AbortController().signal);
    expect(publications.size).toBe(0); expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('surfaces observer publication failures and settles the pending request', async () => {
    let update!: (state: TaskState) => void; let entered!: () => void; let fail = false;
    const ready = new Promise<void>(resolve => { entered = resolve; }); const unsubscribe = vi.fn();
    const source: TaskDataSource = { snapshot: async () => state, subscribe(listener) { update = listener; return unsubscribe; } };
    const host = createBrokerTasksHost({ signal: new AbortController().signal,
      present(value) { if (!('remove' in value) && fail) throw new Error('ownership lost'); },
      request: (_request, { signal }) => new Promise(resolve => { entered(); signal.addEventListener('abort', () => resolve({ state: 'cancelled', reason: 'abort' }), { once: true }); }),
      unsupported: () => { throw new Error('unsupported'); },
    });
    const pending = host.show({} as ExtensionContext['ui'], source, 'inline', new AbortController().signal);
    await ready; fail = true; update({ ...state, revision: 2 });
    await expect(pending).rejects.toThrow('ownership lost'); expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
