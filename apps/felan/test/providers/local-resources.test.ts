import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { getLocalSkillPaths, getLocalSkillSources } from '../../src/providers/local-resources.js';

it('assigns skill scope from the explicitly selected resource roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-sources-'));
  try {
    const cwd = join(root, 'project'); const home = join(root, 'home');
    for (const path of [cwd, home]) await mkdir(join(path, '.agents', 'skills'), { recursive: true });
    expect(getLocalSkillSources(cwd, home)).toEqual([
      { path: join(cwd, '.agents', 'skills'), scope: 'project' },
      { path: join(home, '.agents', 'skills'), scope: 'user' },
    ]);
    expect(getLocalSkillPaths(cwd, home)).toEqual(getLocalSkillSources(cwd, home).map(source => source.path));
    expect(getLocalSkillSources(cwd, cwd)).toEqual([{ path: join(cwd, '.agents', 'skills'), scope: 'project' }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
