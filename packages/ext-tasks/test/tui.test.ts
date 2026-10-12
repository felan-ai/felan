import type { ExtensionContext } from '@felan-ai/agent-core';
import { expect, it, vi } from 'vitest';
import { emptyTaskState } from '../src/graph.js';
import { createTuiTasksHost, taskRenderCalls } from '../src/tui.js';
import type { TaskDataSource } from '../src/host.js';

it('renders only string fields from untrusted or partial tool arguments', () => {
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text } as ExtensionContext['ui']['theme'];
  for (const value of [undefined, null, false, 5, [], { title: {}, task_id: [], status: 3, view: {} }]) {
    for (const render of Object.values(taskRenderCalls)) {
      const result = render!(value, theme, {} as never).render(80).join('\n');
      expect(result).not.toContain('[object Object]');
      expect(result).not.toContain('undefined');
    }
  }
  expect(taskRenderCalls.TaskCreate!({ title: 'Title' }, theme, {} as never).render(80).join('\n')).toContain('Title');
});

it('disposes the view and subscription when its owner aborts', async () => {
  const control = new AbortController(); const unsubscribe = vi.fn(); const done = vi.fn();
  const source: TaskDataSource = { snapshot: async () => emptyTaskState(), subscribe: () => unsubscribe };
  let opened!: () => void;
  const ready = new Promise<void>(resolve => { opened = resolve; });
  const custom = vi.fn((callback: (...args: unknown[]) => unknown, _options?: unknown) => new Promise<void>(resolve => {
    const finish = () => { done(); resolve(); };
    callback({ requestRender: vi.fn() }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }, {}, finish);
    opened();
  }));
  const pending = createTuiTasksHost().show({ custom } as unknown as ExtensionContext['ui'], source, 'overlay', control.signal);
  await ready; control.abort(); await pending;
  expect(done).toHaveBeenCalledTimes(1); expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(custom.mock.calls[0]?.[1]).toMatchObject({ overlay: true, overlayOptions: { minWidth: 72 } });
});
