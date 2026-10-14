import { expect, it } from 'vitest';
import { setupDependencies } from '../../src/providers/dependencies.js';

it('exposes binary-backed setup dependencies without an OS utility installer', () => {
  expect(setupDependencies.map(({ id }) => id)).toEqual([
    'background-bash', 'agent-browser', 'codebase-memory', 'markitdown', 'rtk',
  ]);
  expect(setupDependencies.find(({ id }) => id === 'background-bash')).toMatchObject({
    extension: 'backgroundBash',
  });
  expect(setupDependencies.find(({ id }) => id === 'background-bash')?.install).toBeUndefined();
  expect(setupDependencies.find(({ id }) => id === 'codebase-memory')).toMatchObject({
    revision: 2, description: expect.stringContaining('Codebase Memory 0.11.0'),
  });
  expect(setupDependencies.every(dependency => !('skipDisables' in dependency))).toBe(true);
});
