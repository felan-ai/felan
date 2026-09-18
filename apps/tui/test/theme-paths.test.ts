import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLocalFelanRuntime,
  FELAN_THEME_PATHS,
  getLocalThemePaths,
} from '../src/runtime.js';
import { builtinExtensionPackages } from '../src/extensions.js';

const packagedDark = fileURLToPath(new URL('../src/themes/felan-dark.json', import.meta.url));
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('getLocalThemePaths', () => {
  const packaged = ['/packaged/felan-light.json', '/packaged/felan-dark.json'] as const;

  it('returns only packaged themes when the user themes directory is missing', async () => {
    const agentDir = await temporaryDirectory();
    expect(getLocalThemePaths(agentDir, packaged)).toEqual([...packaged]);
  });

  it('prepends the user directory and keeps packaged themes for unique names', async () => {
    const agentDir = await temporaryDirectory();
    const userThemes = join(agentDir, 'themes');
    await mkdir(userThemes, { recursive: true });
    await writeFile(join(userThemes, 'linux-dark.json'), userTheme('linux-dark'));

    expect(getLocalThemePaths(agentDir, packaged)).toEqual([userThemes, ...packaged]);
  });

  it('omits a packaged theme when a valid user theme reuses its name', async () => {
    const agentDir = await temporaryDirectory();
    const userThemes = join(agentDir, 'themes');
    await mkdir(userThemes, { recursive: true });
    await writeFile(join(userThemes, 'felan-dark.json'), userTheme('felan-dark', '#000000'));

    expect(getLocalThemePaths(agentDir, packaged)).toEqual([
      userThemes,
      '/packaged/felan-light.json',
    ]);
  });

  it('keeps packaged themes when the user file is invalid JSON', async () => {
    const agentDir = await temporaryDirectory();
    const userThemes = join(agentDir, 'themes');
    await mkdir(userThemes, { recursive: true });
    await writeFile(join(userThemes, 'felan-dark.json'), '{');

    expect(getLocalThemePaths(agentDir, packaged)).toEqual([userThemes, ...packaged]);
  });
});

describe('local user theme loading', () => {
  it('loads unique user themes alongside packaged felan-light and felan-dark', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    const userThemes = join(agentDir, 'themes');
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(userThemes, { recursive: true }),
    ]);
    await writeDisabledBuiltins(agentDir);
    await writeFile(join(userThemes, 'linux-dark.json'), userTheme('linux-dark'));
    const runtime = await createLocalFelanRuntime({ cwd, agentDir, homeDir: root });

    expect(runtime.services.resourceLoader.getThemes().diagnostics).toEqual([]);
    expect(loadedThemes(runtime)).toEqual(expect.arrayContaining([
      { name: 'linux-dark', sourcePath: join(userThemes, 'linux-dark.json') },
      { name: 'felan-light', sourcePath: FELAN_THEME_PATHS[0] },
      { name: 'felan-dark', sourcePath: FELAN_THEME_PATHS[1] },
    ]));
    await runtime.dispose();
  });

  it('lets a valid user felan-dark shadow the packaged theme without a collision diagnostic', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    const userThemes = join(agentDir, 'themes');
    const userDark = join(userThemes, 'felan-dark.json');
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(userThemes, { recursive: true }),
    ]);
    await writeDisabledBuiltins(agentDir);
    await writeFile(userDark, userTheme('felan-dark', '#000000'));
    const runtime = await createLocalFelanRuntime({ cwd, agentDir, homeDir: root });
    const themes = loadedThemes(runtime);
    const dark = themes.find((theme) => theme.name === 'felan-dark');

    expect(runtime.services.resourceLoader.getThemes().diagnostics).toEqual([]);
    expect(dark?.sourcePath).toBe(userDark);
    expect(themes.filter((theme) => theme.name === 'felan-dark')).toHaveLength(1);
    expect(themes.some((theme) => theme.sourcePath === FELAN_THEME_PATHS[1])).toBe(false);
    await runtime.dispose();
  });

  it('keeps packaged felan-dark when the user override is invalid JSON', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    const userThemes = join(agentDir, 'themes');
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(userThemes, { recursive: true }),
    ]);
    await writeDisabledBuiltins(agentDir);
    await writeFile(join(userThemes, 'felan-dark.json'), '{');
    const runtime = await createLocalFelanRuntime({ cwd, agentDir, homeDir: root });
    const themes = loadedThemes(runtime);
    const diagnostics = runtime.services.resourceLoader.getThemes().diagnostics;

    expect(themes.find((theme) => theme.name === 'felan-dark')?.sourcePath).toBe(FELAN_THEME_PATHS[1]);
    expect(diagnostics.some((diagnostic) => diagnostic.path === join(userThemes, 'felan-dark.json'))).toBe(true);
    await runtime.dispose();
  });

  it('does not load project .pi/themes', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    const projectThemes = join(cwd, '.pi', 'themes');
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(agentDir, { recursive: true }),
      mkdir(projectThemes, { recursive: true }),
    ]);
    await writeDisabledBuiltins(agentDir);
    await writeFile(join(projectThemes, 'ambient.json'), userTheme('ambient-theme'));
    const runtime = await createLocalFelanRuntime({ cwd, agentDir, homeDir: root });

    expect(loadedThemes(runtime).map((theme) => theme.name)).toEqual(['felan-light', 'felan-dark']);
    await runtime.dispose();
  });
});

function loadedThemes(runtime: Awaited<ReturnType<typeof createLocalFelanRuntime>>) {
  return runtime.services.resourceLoader.getThemes().themes.map((theme) => ({
    name: theme.name,
    sourcePath: theme.sourcePath,
  }));
}

async function writeDisabledBuiltins(agentDir: string): Promise<void> {
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    builtinExtensions: Object.fromEntries(
      Object.keys(builtinExtensionPackages).map((name) => [name, false]),
    ),
  }));
}

function userTheme(name: string, bg = '#111111'): string {
  const theme = JSON.parse(readFileSync(packagedDark, 'utf8')) as {
    name: string;
    vars: { bg: string };
  };
  theme.name = name;
  theme.vars.bg = bg;
  return JSON.stringify(theme);
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-tui-themes-'));
  temporaryPaths.push(path);
  return path;
}
