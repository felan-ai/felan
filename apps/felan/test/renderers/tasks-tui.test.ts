import type { ExtensionContext } from '@felan-ai/agent-core';
import { expect, it } from 'vitest';
import { taskRenderCalls } from '../../src/tui/renderers/tasks.js';

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

