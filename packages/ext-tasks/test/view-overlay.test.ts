import type { ExtensionContext } from '@felan-ai/agent-core';
import { expect, it, vi } from 'vitest';
import type { TaskState } from '../src/contracts.js';
import type { TaskDataSource } from '../src/host.js';
import { TasksOverlay } from '../src/ui/tasks-overlay.js';

const theme = { fg: (_key: string, text: string) => text, bold: (text: string) => text } as ExtensionContext['ui']['theme'];
const state: TaskState = { schemaVersion: 1, revision: 1, tasks: [{ id: 'T-AAAAAA', title: 'Task', priority: 1,
  status: 'pending', blockedBy: [], createdAt: '2026', updatedAt: '2026' }] };

it('retains detail navigation while data is fetched through the host', () => {
  const source: TaskDataSource = { snapshot: async () => state, subscribe: listener => { listener(state); return () => {}; } };
  const details = vi.fn();
  const view = new TasksOverlay(source, theme, vi.fn(), vi.fn(), undefined, 'inline', { requestDetails: details });
  view.handleInput('\r');
  expect(details).toHaveBeenCalledWith('T-AAAAAA');
  expect(view.snapshotNavigation()).toMatchObject({ view: 'detail', selectedTaskId: 'T-AAAAAA' });
  view.dispose();
});

it('sanitizes display strings without changing source task identity or content', () => {
  const raw: TaskState = { ...state, tasks: [{ ...state.tasks[0]!, title: '\u001b[31mUnsafe\u001b[0m\u0000' }] };
  const source: TaskDataSource = { snapshot: async () => raw, subscribe: listener => { listener(raw); return () => {}; } };
  const view = new TasksOverlay(source, theme, vi.fn(), vi.fn());
  const output = view.render(120).join('\n');
  expect(output).toContain('Unsafe'); expect(output).not.toContain('\u001b'); expect(output).not.toContain('\u0000');
  expect(view.snapshotNavigation().selectedTaskId).toBe('T-AAAAAA'); expect(raw.tasks[0]!.title).toContain('\u001b');
  view.dispose();
});
