import type { ExtensionContext } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '../src/contracts.js';
import { createTask, emptyTaskState } from '../src/graph.js';
import type { TaskStore } from '../src/store.js';
import { TasksOverlay } from '../src/ui/tasks-overlay.js';

const now = '2026-01-01T00:00:00.000Z';

describe('TasksOverlay', () => {
  it('scrolls long graph views and unsubscribes once', async () => {
    const state = createTasks(30);
    const unsubscribe = vi.fn();
    const store = {
      subscribe: (listener: (next: TaskState) => void) => {
        listener(state);
        return unsubscribe;
      },
      snapshot: vi.fn(async () => state),
    } as unknown as TaskStore;
    const requestRender = vi.fn();
    const overlay = new TasksOverlay(
      store,
      {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as unknown as ExtensionContext['ui']['theme'],
      vi.fn(),
      requestRender,
    );
    await vi.waitFor(() => expect(store.snapshot).toHaveBeenCalled());

    overlay.handleInput('g');
    expect(overlay.render(100).join('\n')).toContain('Showing lines 1-24/');
    for (let index = 0; index < 30; index += 1) overlay.handleInput('j');
    expect(overlay.render(100).join('\n')).not.toContain('Showing lines 1-24/');

    overlay.dispose();
    overlay.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

function createTasks(count: number): TaskState {
  let state = emptyTaskState();
  for (let index = 0; index < count; index += 1) {
    state = createTask(
      state,
      { title: `Task ${index + 1}` },
      `T-${index.toString().padStart(6, '0')}`,
      now,
    ).state;
  }
  return state;
}
