import { expect, it, vi } from 'vitest';
import { createSessionTitleSync } from '../src/client/session-title.js';

it('shows session names and folder fallbacks without terminal control injection, writing only on change', () => {
  const setTitle = vi.fn();
  const sync = createSessionTitleSync({ setTitle }, '/fallback/folder');
  sync(undefined);
  expect(setTitle).toHaveBeenLastCalledWith('folder');
  sync({ title: 'Review\u001b]2;injection\u0007\n auth', cwd: '/workspace' });
  expect(setTitle.mock.calls.at(-1)![0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
  const count = setTitle.mock.calls.length;
  sync({ title: 'Release plan', cwd: '/workspace' });
  sync({ title: 'Release plan', cwd: '/workspace' });
  expect(setTitle.mock.calls.length).toBe(count + 1);
  expect(setTitle).toHaveBeenLastCalledWith('Release plan');
  sync({ title: '', cwd: '/workspace/project/' });
  expect(setTitle).toHaveBeenLastCalledWith('project');
});
