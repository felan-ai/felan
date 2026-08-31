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

  it('wraps long task details within the requested width', async () => {
    const state = createTask(emptyTaskState(), {
      title: 'A task with a deliberately long title for narrow terminals',
      description: 'A deliberately long description that should wrap instead of disappearing beyond the terminal edge.',
      acceptanceCriteria: 'The detail view remains readable.',
    }, 'T-AAAAAA', now).state;
    const store = {
      subscribe: (listener: (next: TaskState) => void) => {
        listener(state);
        return () => {};
      },
      snapshot: vi.fn(async () => state),
    } as unknown as TaskStore;
    const overlay = new TasksOverlay(store, {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as ExtensionContext['ui']['theme'], vi.fn(), vi.fn());
    await vi.waitFor(() => expect(store.snapshot).toHaveBeenCalled());

    overlay.handleInput('\r');
    const lines = overlay.render(36);
    expect(lines.every((line) => line.length <= 36)).toBe(true);
    expect(lines.join('\n').replace(/\s+/gu, ' ')).toContain('Description: A deliberately long');
  });

  it('bounds and scrolls task details by wrapped visual rows', async () => {
    const state = createTask(emptyTaskState(), {
      title: 'Wrapped detail rows',
      description: `First marker ${'x'.repeat(1_500)} Last marker`,
    }, 'T-AAAAAA', now).state;
    const store = {
      subscribe: (listener: (next: TaskState) => void) => {
        listener(state);
        return () => {};
      },
      snapshot: vi.fn(async () => state),
    } as unknown as TaskStore;
    const overlay = new TasksOverlay(store, {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as ExtensionContext['ui']['theme'], vi.fn(), vi.fn());
    await vi.waitFor(() => expect(store.snapshot).toHaveBeenCalled());

    overlay.handleInput('\r');
    const first = overlay.render(36);
    expect(first.length).toBeLessThanOrEqual(32);
    expect(first.join('\n')).toContain('Showing lines 1-24/');
    expect(first.join('\n')).not.toContain('Last marker');

    for (let index = 0; index < 100; index += 1) overlay.handleInput('j');
    const last = overlay.render(36);
    expect(last.length).toBeLessThanOrEqual(32);
    expect(last.join('\n')).not.toContain('Showing lines 1-24/');
    expect(last.join('\n')).toContain('Last marker');
  });

  it('uses two horizontal separators inline and a four-edge frame in overlay mode', async () => {
    const state = createTasks(1);
    const store = {
      subscribe: (listener: (next: TaskState) => void) => {
        listener(state);
        return () => {};
      },
      snapshot: vi.fn(async () => state),
    } as unknown as TaskStore;
    const makeView = (displayMode: 'inline' | 'overlay') => new TasksOverlay(
      store,
      { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as ExtensionContext['ui']['theme'],
      vi.fn(),
      vi.fn(),
      vi.fn(),
      displayMode,
    );

    const inline = makeView('inline').render(40);
    expect(inline[0]).toBe('─'.repeat(40));
    expect(inline.at(-1)).toBe('─'.repeat(40));
    expect(inline.some((line) => line.startsWith('│'))).toBe(false);

    const overlay = makeView('overlay').render(40);
    expect(overlay[0]).toBe(`╭${'─'.repeat(38)}╮`);
    expect(overlay.at(-1)).toBe(`╰${'─'.repeat(38)}╯`);
    expect(overlay.slice(1, -1).every((line) => line.startsWith('│') && line.endsWith('│'))).toBe(true);
    expect(overlay.every((line) => line.length <= 40)).toBe(true);
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
