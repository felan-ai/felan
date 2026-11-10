import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// One vitest process with one worker pool for every workspace. Running packages through
// `pnpm -r` starts a full-size pool per package at once, and the oversubscription makes
// timing-sensitive tests fail under load. The file is not named vitest.config.ts because
// Vitest searches parent directories for that name, and package-level runs must keep
// their own defaults.
const projects = ['apps', 'packages'].flatMap((group) => {
  const groupDir = join(import.meta.dirname, group);
  return readdirSync(groupDir)
    .map((name) => join(group, name))
    .filter((dir) => {
      const manifest = join(import.meta.dirname, dir, 'package.json');
      return existsSync(manifest) && Boolean(JSON.parse(readFileSync(manifest, 'utf8')).scripts?.test);
    });
});

export default defineConfig({
  test: {
    projects,
  },
});
