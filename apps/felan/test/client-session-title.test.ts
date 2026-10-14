import { expect, it, vi } from 'vitest';
import { presentSessionTitle } from '../src/client/session-title.js';

it('renders projected titles and cwd fallbacks without terminal control injection', () => {
  const setTitle = vi.fn();
  presentSessionTitle({ title: 'Review\u001b]2;injection\u0007\n auth', cwd: '/workspace' }, { setTitle });
  expect(setTitle.mock.calls[0]![0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
  presentSessionTitle({ title: '', cwd: '/workspace/project/' }, { setTitle });
  expect(setTitle).toHaveBeenLastCalledWith('project');
});
