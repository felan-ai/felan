import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  piProjectExtensionsDir,
  piUserExtensionsDir,
  resolveInteractivePiExtensionPaths,
  resolvePiExtensionPaths,
} from '../src/pi-extensions.js';
import { createFelanProjectTrustStore } from '../src/project-trust.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('Pi extension path resolution', () => {
  it('returns only CLI paths when both sources are off', async () => {
    const layout = await createLayout();
    const cliPath = join(layout.root, 'explicit.mjs');
    await writeFile(cliPath, '');

    expect(resolvePiExtensionPaths({
      cwd: layout.cwd,
      homeDir: layout.homeDir,
      settings: { user: false, project: false },
      projectTrust: true,
      cliPaths: [cliPath],
    })).toEqual({
      paths: [cliPath],
      needsProjectTrustPrompt: false,
    });
  });

  it('loads the user Pi directory and ignores project extensions', async () => {
    const layout = await createLayout({ user: true, project: true, felan: true });

    expect(resolvePiExtensionPaths({
      cwd: layout.cwd,
      homeDir: layout.homeDir,
      settings: { user: true, project: false },
      projectTrust: true,
    })).toEqual({
      paths: [layout.userFile],
      needsProjectTrustPrompt: false,
    });
  });

  it('loads trusted project extensions and omits untrusted or unknown ones', async () => {
    const layout = await createLayout({ project: true });
    const trusted = resolvePiExtensionPaths({
      cwd: layout.cwd,
      homeDir: layout.homeDir,
      settings: { user: false, project: true },
      projectTrust: true,
    });
    const untrusted = resolvePiExtensionPaths({
      cwd: layout.cwd,
      homeDir: layout.homeDir,
      settings: { user: false, project: true },
      projectTrust: false,
    });
    const unknown = resolvePiExtensionPaths({
      cwd: layout.cwd,
      homeDir: layout.homeDir,
      settings: { user: false, project: true },
      projectTrust: null,
    });

    expect(trusted).toEqual({ paths: [layout.projectFile], needsProjectTrustPrompt: false });
    expect(untrusted).toEqual({ paths: [], needsProjectTrustPrompt: false });
    expect(unknown).toEqual({ paths: [], needsProjectTrustPrompt: true });
  });

  it('omits missing directories and keeps CLI paths last', async () => {
    const layout = await createLayout();
    const cliPath = join(layout.root, 'explicit.mjs');
    await writeFile(cliPath, '');

    expect(resolvePiExtensionPaths({
      cwd: layout.cwd,
      homeDir: layout.homeDir,
      settings: { user: true, project: true },
      projectTrust: null,
      cliPaths: [cliPath],
    })).toEqual({
      paths: [cliPath],
      needsProjectTrustPrompt: false,
    });
  });

  it('never includes Felan agentDir extensions', async () => {
    const layout = await createLayout({ user: true, project: true, felan: true });

    expect(resolvePiExtensionPaths({
      cwd: layout.cwd,
      homeDir: layout.homeDir,
      settings: { user: true, project: true },
      projectTrust: true,
    }).paths).toEqual([layout.userFile, layout.projectFile]);
    expect(layout.felanDir).toBeDefined();
  });

  it('prompts for unknown project trust and loads after confirmation', async () => {
    const layout = await createLayout({ project: true });
    const store = createFelanProjectTrustStore(layout.agentDir);
    const prompt = async () => 'trust' as const;

    await expect(resolveInteractivePiExtensionPaths({
      cwd: layout.cwd,
      homeDir: layout.homeDir,
      agentDir: layout.agentDir,
      settings: { user: false, project: true },
      store,
      prompt,
    })).resolves.toEqual([layout.projectFile]);
    expect(store.get(layout.cwd)).toBe(true);
  });
});

async function createLayout(present: {
  readonly user?: boolean;
  readonly project?: boolean;
  readonly felan?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'felan-tui-pi-extensions-'));
  temporaryPaths.push(root);
  const cwd = join(root, 'workspace');
  const homeDir = join(root, 'home');
  const agentDir = join(root, '.felan');
  const userDir = piUserExtensionsDir(homeDir);
  const projectDir = piProjectExtensionsDir(cwd);
  const felanDir = join(agentDir, 'extensions');
  await mkdir(cwd, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const userFile = join(userDir, 'home.js');
  const projectFile = join(projectDir, 'project.js');
  if (present.user) {
    await mkdir(userDir, { recursive: true });
    await writeFile(userFile, 'export default () => {};');
  }
  if (present.project) {
    await mkdir(projectDir, { recursive: true });
    await writeFile(projectFile, 'export default () => {};');
  }
  if (present.felan) {
    await mkdir(felanDir, { recursive: true });
    await writeFile(join(felanDir, 'felan.js'), 'export default () => {};');
  }
  return { root, cwd, homeDir, agentDir, userDir, projectDir, felanDir, userFile, projectFile };
}
